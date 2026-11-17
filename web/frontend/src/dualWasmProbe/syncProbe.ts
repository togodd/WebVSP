import { openEngineFile, saveEngineFile, syncProbeEngineCall, WasmEngineError } from '../api/wasmEngine'

const MAX_BYTES = 64 * 1024
const RESPONSE_HEADER_BYTES = 8

// Keep in step with openvsp_live.py: these calls can mutate model, analysis or results state.
const LIVE_WRITES = new Set([
  'live_add_geom', 'live_delete_geom', 'live_update', 'live_parm_set', 'live_parm_set_by_id',
  'live_analysis_defaults', 'live_analysis_set_int', 'live_analysis_set_double', 'live_analysis_set_string', 'live_analysis_run', 'live_insert_xsec',
  'live_delete_xsec', 'live_insert_xsec_by_id', 'live_delete_xsec_by_id',
  'live_xsec_set_width', 'live_xsec_set_height', 'live_xsec_set_width_height',
  'live_copy_xsec', 'live_copy_xsec_by_id', 'live_paste_xsec', 'live_paste_xsec_by_id',
  'live_xsec_set_alias', 'live_xsec_set_curve_alias', 'live_xsec_set_continuity',
  'live_xsec_set_tan_angles', 'live_xsec_set_tan_slews', 'live_xsec_set_tan_strengths',
  'live_xsec_set_curvatures',
  'live_change_xsec_shape', 'live_add_sub_surf', 'live_delete_sub_surf',
  'live_reorder_sub_surf', 'live_set_sub_surf_name', 'live_set_set_name', 'live_set_set_flag', 'live_delete_result', 'live_delete_all_results',
  'live_parm_set_update', 'live_set_geom_name',
  'live_update_geom', 'live_set_geom_parent', 'live_copy_geom', 'live_cut_geom', 'live_paste_geom',
  'live_geom_set_draw_type', 'live_geom_set_display_type', 'live_geom_set_wire_color',
  'live_geom_set_material',
  'live_parm_set_descript', 'live_parm_set_limits', 'live_clone_geom_vec', 'live_delete_geom_vec',
  'live_copy_paste_set',
  'live_vspaero_kill',
  'live_api_write',
  'live_attribute_set_matrix', 'live_attribute_add',
  'live_add_probe', 'live_add_rst_probe', 'live_add_ruler', 'live_add_protractor',
  'live_vspaero_set_ref_wing', 'live_vspaero_set_mode', 'live_vspaero_set_cg_mode',
  'live_vspaero_add_cs_group', 'live_vspaero_auto_group', 'live_vspaero_delete_cs_group',
  'live_vspaero_add_all_cs_group', 'live_vspaero_remove_all_cs_group', 'live_vspaero_set_cs_name',
])
// File operations also mutate the session: ReadVSPFile replaces the model and
// WriteVSPFile renames it, so both carry write-outcome semantics.
const FILE_OPS = new Set(['read_file', 'write_file', 'import_file', 'export_file', 'set_vsp_file_name', 'clear_model'])
const isWrite = (op: string) => LIVE_WRITES.has(op) || FILE_OPS.has(op)

function responseTooLarge(write: boolean, issued: boolean, capacity: number): string {
  return JSON.stringify({ ok: false, error: { message: `Synchronous response exceeds ${capacity}-byte limit`, code: 'RESPONSE_TOO_LARGE', ...(write ? { outcome: issued ? 'unknown' : 'not_written' } : {}) } })
}
function encodeResponse(response: unknown, write: boolean, issued: boolean, capacity: number): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(response))
  if (encoded.length <= capacity) return encoded
  const fallback = new TextEncoder().encode(responseTooLarge(write, issued, capacity))
  if (fallback.length > capacity) throw new Error('Response overflow fallback exceeds transport limit')
  return fallback
}

/**
 * Run user Python against the live page model. The native-shaped `openvsp`
 * module is available, as are the original degen_geom/surface patching helpers.
 * This is arbitrary code in the user's own page: not a security boundary.
 */
export function runSyncScript(code: string): Promise<unknown> { return run('script', code) }

export interface ConsoleProfile {
  calls: number
  waitMs: number
  responseBytes: number
  elapsedMs: number
  byOp: Record<string, { calls: number; waitMs: number; bytes: number }>
}

export interface ConsoleResult {
  ok: boolean
  value: string
  stdout: string
  error?: string
  profile?: ConsoleProfile
}

export interface ConsoleSession {
  run(code: string, profile?: boolean): Promise<ConsoleResult>
  close(): void
}

/**
 * A long-lived Python session over the live model. Reuses the same bridge so
 * Python calls reach the page engine exactly as in script mode.
 */
export function startConsoleSession(): Promise<ConsoleSession> {
  return run('console') as Promise<ConsoleSession>
}

async function run(mode: 'script' | 'console', script?: string): Promise<unknown> {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Cross-origin isolation and SharedArrayBuffer are required')
  const worker = new Worker(new URL('./syncWorker.ts', import.meta.url), { type: 'module' })
  const assets = new URL(`${import.meta.env.BASE_URL}pyodide/`, window.location.href).href
  return new Promise((resolve, reject) => {
    let finished = false
    let active = false
    let poisoned = false
    let dispatchedWrite = false
    let currentWriteIssued = false
    let consoleRunId = 0
    const consoleRuns = new Map<number, { resolve: (r: ConsoleResult) => void; reject: (e: Error) => void }>()
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      worker.terminate()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error(dispatchedWrite ? 'Synchronous probe timed out after a write was dispatched; its outcome may be unknown. Do not retry automatically.' : 'Synchronous probe timed out before a model write was dispatched.')), 120_000)
    async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
      const textArg = (key: string) => {
        const v = args[key]
        if (typeof v !== 'string' || !v) throw new WasmEngineError(400, `Invalid ${key}`, 'not_written')
        return v
      }
      if (op === 'find_geoms') return syncProbeEngineCall('liveFindGeoms')
      if (op === 'find_geom') {
        const index = args.index
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw new WasmEngineError(400, 'Invalid index', 'not_written')
        return syncProbeEngineCall('liveFindGeom', textArg('name'), '', index)
      }
      if (op === 'geom_name') return syncProbeEngineCall('liveGeomName', textArg('geom_id'))
      if (op === 'geom_type') return syncProbeEngineCall('liveGeomTypeName', textArg('geom_id'))
      if (op === 'geom_parent') return syncProbeEngineCall('liveGeomParent', textArg('geom_id'))
      if (op === 'geom_children') return syncProbeEngineCall('liveGeomChildren', textArg('geom_id'))
      if (op === 'geom_parm_ids') return syncProbeEngineCall('geomParmIDs', textArg('geom_id'))
      if (FILE_OPS.has(op)) {
        if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
        dispatchedWrite = true
        currentWriteIssued = true
        if (op === 'clear_model') return syncProbeEngineCall('newModel')
        const path = textArg('path')
        if (op === 'read_file') return syncProbeEngineCall('readFile', path)
        if (op === 'write_file') return syncProbeEngineCall('writeFile', path)
        if (op === 'set_vsp_file_name') return syncProbeEngineCall('setVspFileName', path)
        if (op === 'import_file') {
          const fileType = args.file_type
          if (typeof fileType !== 'number' || !Number.isSafeInteger(fileType) || fileType < 0 || fileType > 8) {
            throw new WasmEngineError(400, 'Invalid import type', 'not_written')
          }
          return syncProbeEngineCall('importFile', path, String(fileType))
        }
        if (op === 'export_file') {
          const fileType = args.file_type
          const set = args.set
          if (typeof fileType !== 'number' || !Number.isSafeInteger(fileType) || fileType < 0 || fileType > 26) {
            throw new WasmEngineError(400, 'Invalid export type', 'not_written')
          }
          if (typeof set !== 'number' || !Number.isSafeInteger(set)) {
            throw new WasmEngineError(400, 'Invalid export set', 'not_written')
          }
          return syncProbeEngineCall('exportFile', path, String(fileType), set)
        }
      }
      if (op === 'get_vsp_file_name') return syncProbeEngineCall('getVspFileName')
      if (op.startsWith('live_')) {
        const live = (engineOp: string, a = '', b = '', value = 0) => {
          if (isWrite(op)) {
            if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
            dispatchedWrite = true
            currentWriteIssued = true
          }
          return syncProbeEngineCall(engineOp, a, b, value)
        }
        const text = (key: string) => {
          const v = args[key]
          if (typeof v !== 'string' || !v) throw new WasmEngineError(400, `Invalid ${key}`, 'not_written')
          return v
        }
        if (op === 'live_add_geom') {
          const type = text('type')
          const parent = args.parent === undefined || args.parent === '' ? '' : text('parent')
          const result = await live('addGeom', type, parent)
          const id = (result as { id?: string })?.id
          if (!id) throw new Error('Geometry creation returned no ID')
          return id
        }
        if (op === 'live_geom_types') return live('geomTypes')
        if (op === 'live_vspaero_files') return live('liveVSPAEROFiles')
        if (op === 'live_vspaero_output') return live('liveVSPAEROOutput')
        if (op === 'live_api' || op === 'live_api_write') {
          const fn = text('fn'), shape = text('shape')
          const values = args.args
          if (!Array.isArray(values) || values.length > 4) throw new WasmEngineError(400, 'Invalid API arguments', 'not_written')
          const encoder = new TextEncoder()
          const packed = values.map(value => {
            if (typeof value === 'string') return value
            if (typeof value === 'boolean') return value ? '1' : '0'
            if (typeof value === 'number' && Number.isFinite(value)) return String(value)
            if (Array.isArray(value)) return value.map(entry => Array.isArray(entry) ? entry.join(',') : String(entry)).join('\n')
            throw new WasmEngineError(400, 'Invalid API argument', 'not_written')
          })
          const packet = `${packed.length};` + packed.map(v => `${encoder.encode(v).length}:${v}`).join('')
          return live('liveApi', fn, `${shape}\x1f${packet}`, 0)
        }
        if (op === 'live_vspaero_ref_wing') return live('liveVSPAERORefWing')
        if (op === 'live_vspaero_set_ref_wing') return live('liveVSPAEROSetRefWing', text('geom_id'))
        if (op === 'live_vspaero_mode') return live('liveVSPAEROMode')
        if (op === 'live_vspaero_set_mode') return live('liveVSPAEROSetMode', text('mode_id'))
        if (op === 'live_vspaero_cg_mode') return live('liveVSPAEROCGMode')
        if (op === 'live_vspaero_set_cg_mode') return live('liveVSPAEROSetCGMode', text('mode_id'))
        if (op === 'live_vspaero_path') return live('liveVSPAEROPath')
        if (op === 'live_vspaero_add_cs_group') return live('liveVSPAEROAddCSGroup')
        if (op === 'live_vspaero_auto_group') return live('liveVSPAEROAutoGroup')
        if (op === 'live_vspaero_delete_cs_group' || op === 'live_vspaero_add_all_cs_group' || op === 'live_vspaero_remove_all_cs_group') {
          const index = args.index
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new WasmEngineError(400, 'Invalid control surface group index', 'not_written')
          const engineOps: Record<string, string> = {
            live_vspaero_delete_cs_group: 'liveVSPAERODeleteCSGroup',
            live_vspaero_add_all_cs_group: 'liveVSPAEROAddAllCSGroup',
            live_vspaero_remove_all_cs_group: 'liveVSPAERORemoveAllCSGroup',
          }
          return live(engineOps[op], '', '', index)
        }
        if (op === 'live_vspaero_get_cs_name') {
          const index = args.index
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new WasmEngineError(400, 'Invalid control surface group index')
          return live('liveVSPAEROGetCSName', '', '', index)
        }
        if (op === 'live_vspaero_set_cs_name') {
          const index = args.index
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new WasmEngineError(400, 'Invalid control surface group index', 'not_written')
          return live('liveVSPAEROSetCSName', text('name'), '', index)
        }
        if (op === 'live_vspaero_kill') return live('liveVSPAEROKill')
        if (op === 'live_comp_pnt01' || op === 'live_comp_norm01') {
          const id = text('geom_id'), index = args.surf_indx, u = args.u, w = args.w
          if (typeof index !== 'number' || !Number.isInteger(index) || index < -2147483648 || index > 2147483647) throw new WasmEngineError(400, 'Invalid surf_indx')
          if (typeof u !== 'number' || !Number.isFinite(u) || typeof w !== 'number' || !Number.isFinite(w)) throw new WasmEngineError(400, 'Invalid surface coordinate')
          return live(op === 'live_comp_pnt01' ? 'liveCompPnt01' : 'liveCompNorm01', id, `${index},${w}`, u)
        }
        if (op === 'live_num_main_surfs') return live('liveNumMainSurfs', text('geom_id'))
        const numbers = (values: unknown[], expected?: number): string => {
          if (expected !== undefined && values.length !== expected) throw new WasmEngineError(400, 'Invalid numeric arguments')
          return values.map(v => {
            if (typeof v !== 'number' || !Number.isFinite(v)) throw new WasmEngineError(400, 'Invalid numeric argument')
            return String(v)
          }).join('\x1f')
        }
        if (op === 'live_xsec_tangent_u' || op === 'live_xsec_tangent_w') {
          const index = args.surf_indx, u = args.u, w = args.w
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          return live(op === 'live_xsec_tangent_u' ? 'liveXSecTangentU' : 'liveXSecTangentW', text('geom_id'), numbers([u, w], 2), index)
        }
        if (op === 'live_add_probe' || op === 'live_add_rst_probe') {
          const index = args.surf_indx
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx', 'not_written')
          const values = (op === 'live_add_probe' ? [args.u, args.w, 0] : [args.r, args.s, args.t]) as unknown[]
          return live(op === 'live_add_probe' ? 'liveAddProbe' : 'liveAddRSTProbe', text('geom_id'),
            `${String(index)}\x1f${values.map(v => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new WasmEngineError(400, 'Invalid coordinate', 'not_written'); return String(v) }).join(',')}\x1f${args.name ?? ''}`, 0)
        }
        if (op === 'live_add_ruler' || op === 'live_add_protractor') {
          const anchors = args.anchors
          if (!Array.isArray(anchors) || anchors.length !== (op === 'live_add_ruler' ? 2 : 3)) {
            throw new WasmEngineError(400, 'Invalid measurement anchors', 'not_written')
          }
          const packed = anchors.map(anchor => {
            if (!anchor || typeof anchor.geom_id !== 'string' || typeof anchor.surf_indx !== 'number' ||
                !Number.isInteger(anchor.surf_indx) || typeof anchor.u !== 'number' || typeof anchor.w !== 'number') {
              throw new WasmEngineError(400, 'Invalid measurement anchor', 'not_written')
            }
            return `${anchor.geom_id},${anchor.surf_indx},${anchor.u},${anchor.w}`
          })
          return live(op === 'live_add_ruler' ? 'liveAddRuler' : 'liveAddProtractor',
            '', [...packed, String(args.name ?? '')].join('\x1f'), 0)
        }
        if (op === 'live_attribute_find' || op === 'live_attribute_get_id') {
          const index = args.index === undefined ? 0 : args.index
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new WasmEngineError(400, 'Invalid attribute index')
          return live(op === 'live_attribute_find' ? 'liveAttributeFind' : 'liveAttributeGetID', text('collection_id'), text('name'), index)
        }
        if (op === 'live_attribute_ids_by_name') {
          return live('liveAttributeIDsByName', text('collection_id'), text('name'))
        }
        if (op === 'live_attribute_matrix') {
          if (args.kind !== 'int' && args.kind !== 'double') throw new WasmEngineError(400, 'Invalid matrix kind')
          return live('liveAttributeMatrix', text('attribute_id'), String(args.kind))
        }
        if (op === 'live_attribute_set_matrix') {
          if (args.kind !== 'int' && args.kind !== 'double') throw new WasmEngineError(400, 'Invalid matrix kind', 'not_written')
          const rows = args.rows
          if (!Array.isArray(rows) || !rows.length) throw new WasmEngineError(400, 'Invalid matrix', 'not_written')
          const rowsText = rows.map(row => {
            if (!Array.isArray(row) || !row.length || row.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
              throw new WasmEngineError(400, 'Invalid matrix', 'not_written')
            }
            return row.join(',')
          }).join(';')
          return live('liveAttributeSetMatrix', text('attribute_id'), `${args.kind}\x1f${rowsText}`)
        }
        if (op === 'live_attribute_add') {
          const kind = args.kind, payload = args.payload
          if (typeof kind !== 'string' || typeof payload !== 'string') throw new WasmEngineError(400, 'Invalid attribute', 'not_written')
          return live('liveAttributeAdd', text('collection_id'), `${kind}\x1f${text('name')}\x1f${payload}`)
        }
        if (op === 'live_compare_geom_surfaces') return live('liveCompareGeomSurfaces', text('geom_a'), text('geom_b'))
        if (op === 'live_inside_surf') {
          const index = args.surf_indx
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          return live('liveInsideSurf', text('geom_id'), numbers(args.point as unknown[], 3), index)
        }
        if (op === 'live_comp_pnt_rst') {
          const index = args.surf_indx
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          return live('liveCompPntRST', text('geom_id'), numbers([args.r, args.s, args.t], 3), index)
        }
        if (op === 'live_convert_rst_lmn' || op === 'live_convert_lmn_rst') {
          const index = args.surf_indx
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          return live(op === 'live_convert_rst_lmn' ? 'liveConvertRSTtoLMN' : 'liveConvertLMNtoRST', text('geom_id'), numbers(args.values as unknown[], 3), index)
        }
        if (op === 'live_proj_pnt01_guess' || op === 'live_axis_proj_pnt01' || op === 'live_axis_proj_pnt01_guess') {
          const index = args.surf_indx
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          const values = [args.point, ...(args.extra as unknown[] ?? [])] as unknown[]
          return live(op === 'live_proj_pnt01_guess' ? 'liveProjPnt01Guess'
            : op === 'live_axis_proj_pnt01' ? 'liveAxisProjPnt01' : 'liveAxisProjPnt01Guess',
            text('geom_id'), numbers(values.flat(), op === 'live_proj_pnt01_guess' ? 5 : op === 'live_axis_proj_pnt01' ? 4 : 6), index)
        }
        if (op === 'live_proj_pnt01_i' || op === 'live_axis_proj_pnt01_i') {
          const values = op === 'live_proj_pnt01_i'
            ? (args.point as unknown[])
            : [...(args.point as unknown[]), args.iaxis]
          return live(op === 'live_proj_pnt01_i' ? 'liveProjPnt01I' : 'liveAxisProjPnt01I', text('geom_id'), numbers(values, op === 'live_proj_pnt01_i' ? 3 : 4), 0)
        }
        if (op === 'live_find_rst' || op === 'live_find_rst_guess') {
          const index = args.surf_indx
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          const values = [...(args.point as unknown[]), ...(args.guess as unknown[] ?? [])]
          return live(op === 'live_find_rst' ? 'liveFindRST' : 'liveFindRSTGuess', text('geom_id'), numbers(values, op === 'live_find_rst' ? 3 : 6), index)
        }
        if (op === 'live_comp_vec_pnt01' || op === 'live_comp_vec_norm01') {
          const id = text('geom_id'), index = args.surf_indx, us = args.us, ws = args.ws
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          if (!Array.isArray(us) || !Array.isArray(ws) || us.length !== ws.length || us.length === 0 || us.length > 512) {
            throw new WasmEngineError(400, 'Invalid surface coordinates')
          }
          if (![...us, ...ws].every(v => typeof v === 'number' && Number.isFinite(v))) throw new WasmEngineError(400, 'Invalid surface coordinate')
          const encoder = new TextEncoder(), items = [String(index), ...us.map(String), ...ws.map(String)]
          return live(op === 'live_comp_vec_pnt01' ? 'liveCompVecPnt01' : 'liveCompVecNorm01', id, `${items.length};` + items.map(i => `${encoder.encode(i).length}:${i}`).join(''), 0)
        }
        if (op === 'live_proj_pnt01') {
          const id = text('geom_id'), index = args.surf_indx, p = args.point
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          if (!Array.isArray(p) || p.length !== 3 || !p.every(v => typeof v === 'number' && Number.isFinite(v))) throw new WasmEngineError(400, 'Invalid point')
          return live('liveProjPnt01', id, [index, ...p].join('\x1f'), 0)
        }
        if (op === 'live_comp_curvature01') {
          const id = text('geom_id'), index = args.surf_indx, u = args.u, w = args.w
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          if (typeof u !== 'number' || !Number.isFinite(u) || typeof w !== 'number' || !Number.isFinite(w)) throw new WasmEngineError(400, 'Invalid surface coordinate')
          return live('liveCompCurvature01', id, `${index}\x1f${w}`, u)
        }
        if (op === 'live_uw_tess01') {
          const id = text('geom_id'), index = args.surf_indx
          if (typeof index !== 'number' || !Number.isInteger(index)) throw new WasmEngineError(400, 'Invalid surf_indx')
          return live('liveUWTess01', id, String(index), 0)
        }
        if (op === 'live_geom_draw_type') return live('liveGeomDrawType', text('geom_id'))
        if (op === 'live_geom_display_type') return live('liveGeomDisplayType', text('geom_id'))
        if (op === 'live_geom_set_draw_type' || op === 'live_geom_set_display_type') {
          const type = args.type
          if (typeof type !== 'number' || !Number.isInteger(type)) throw new WasmEngineError(400, 'Invalid display type', 'not_written')
          return live(op === 'live_geom_set_draw_type' ? 'liveGeomSetDrawType' : 'liveGeomSetDisplayType', text('geom_id'), '', type)
        }
        if (op === 'live_geom_wire_color') return live('liveGeomWireColor', text('geom_id'))
        if (op === 'live_geom_set_wire_color') {
          const rgb = args.rgb
          if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some(v => typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255)) {
            throw new WasmEngineError(400, 'Invalid wire colour', 'not_written')
          }
          return live('liveGeomSetWireColor', text('geom_id'), rgb.join('\x1f'))
        }
        if (op === 'live_geom_material') return live('liveGeomMaterial', text('geom_id'))
        if (op === 'live_geom_set_material') {
          const name = args.name
          if (typeof name !== 'string') throw new WasmEngineError(400, 'Invalid material name', 'not_written')
          return live('liveGeomSetMaterial', text('geom_id'), name)
        }
        if (op === 'live_geom_bbox_min' || op === 'live_geom_bbox_max') {
          const surf = args.surf === undefined ? 0 : args.surf
          if (typeof surf !== 'number' || !Number.isInteger(surf)) throw new WasmEngineError(400, 'Invalid main surface index')
          return live(op === 'live_geom_bbox_min' ? 'liveGeomBBoxMin' : 'liveGeomBBoxMax', text('geom_id'), args.absolute === false ? '0' : '1', surf)
        }
        if (op === 'live_update_geom' || op === 'live_copy_geom') {
          await live(op === 'live_update_geom' ? 'liveUpdateGeom' : 'liveCopyGeom', text('geom_id'))
          return null
        }
        if (op === 'live_set_geom_parent') {
          const parent = args.parent_id
          if (typeof parent !== 'string') throw new WasmEngineError(400, 'Invalid parent_id', 'not_written')
          await live('liveSetGeomParent', text('geom_id'), parent)
          return null
        }
        if (op === 'live_paste_geom') {
          const parent = args.parent === undefined ? '' : args.parent
          if (typeof parent !== 'string') throw new WasmEngineError(400, 'Invalid parent', 'not_written')
          return live('livePasteGeom', parent)
        }
        if (op === 'live_cut_geom') {
          const id = text('geom_id'), policy = args.clone_delete
          if (typeof policy !== 'number' || !Number.isInteger(policy) || policy < 0 || policy > 2) {
            throw new WasmEngineError(400, 'Invalid clone_delete policy', 'not_written')
          }
          await live('liveCutGeom', id, '', policy)
          return null
        }
        if (op === 'live_delete_geom') {
          const id = text('geom_id')
          const policy = args.clone_delete
          if (typeof policy !== 'number' || !Number.isInteger(policy) || policy < 0 || policy > 2) {
            throw new WasmEngineError(400, 'Invalid clone_delete policy', 'not_written')
          }
          await live('liveDeleteGeom', id, '', policy)
          return null
        }
        if (op === 'live_clone_geom_vec' || op === 'live_delete_geom_vec') {
          const ids = args.geom_ids
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1024 || ids.some(id => typeof id !== 'string' || !id)) {
            throw new WasmEngineError(400, 'Invalid geometry ID list', 'not_written')
          }
          const encoder = new TextEncoder()
          const packet = `${ids.length};` + ids.map(id => `${encoder.encode(id).length}:${id}`).join('')
          if (op === 'live_clone_geom_vec') {
            const suffix = args.name_suffix === undefined ? '_Clone' : args.name_suffix
            if (typeof suffix !== 'string') throw new WasmEngineError(400, 'Invalid clone suffix', 'not_written')
            return live('liveCloneGeomVec', packet, suffix)
          }
          const policy = args.clone_delete
          if (typeof policy !== 'number' || !Number.isInteger(policy) || policy < 0 || policy > 2) {
            throw new WasmEngineError(400, 'Invalid clone_delete policy', 'not_written')
          }
          await live('liveDeleteGeomVec', packet, '', policy)
          return null
        }
        if (op === 'live_copy_paste_set') {
          const copy = args.copy_index, paste = args.paste_index
          if (typeof copy !== 'number' || !Number.isInteger(copy) || copy < 0 || copy > 2147483647) throw new WasmEngineError(400, 'Invalid set index', 'not_written')
          if (typeof paste !== 'number' || !Number.isInteger(paste) || paste < 0 || paste > 2147483647) throw new WasmEngineError(400, 'Invalid set index', 'not_written')
          await live('liveCopyPasteSet', '', String(paste), copy)
          return null
        }
        if (op === 'live_geom_set_collection') {
          const index = args.index
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 2147483647) throw new WasmEngineError(400, 'Invalid set index')
          return live('liveGeomSetCollection', '', '', index)
        }
        if (op === 'live_update') {
          await live('liveUpdate')
          return null
        }
        if (op === 'live_parm_get') {
          return live('liveParmGet', text('geom_id'), text('key'))
        }
        if (op === 'live_parm_value_by_id') return live('liveParmValueById', text('parm_id'))
        if (op === 'live_parm_type') return live('liveParmType', text('parm_id'))
        if (op === 'live_parm_limits') return live('liveParmLimits', text('parm_id'))
        if (op === 'live_parm_active') return live('liveParmActive', text('parm_id'))
        if (op === 'live_parm_name') return live('liveParmName', text('parm_id'))
        if (op === 'live_parm_group') return live('liveParmGroup', text('parm_id'))
        if (op === 'live_parm_display_group') return live('liveParmDisplayGroup', text('parm_id'))
        if (op === 'live_parm_find') return live('liveParmFind', text('container_id'), text('key'))
        if (op === 'live_parm_descript') return live('liveParmDescript', text('parm_id'))
        if (op === 'live_parm_set_descript') {
          const description = args.description
          if (typeof description !== 'string') throw new WasmEngineError(400, 'Invalid parameter description', 'not_written')
          return live('liveParmSetDescript', text('parm_id'), description)
        }
        if (op === 'live_parm_container') return live('liveParmContainer', text('parm_id'))
        if (op === 'live_parm_set_limits') {
          const values = args.values
          if (!Array.isArray(values) || values.length !== 3 || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
            throw new WasmEngineError(400, 'Invalid parameter limits', 'not_written')
          }
          const [value, lower, upper] = values as number[]
          return live('liveParmSetLimits', text('parm_id'), `${lower}\x1f${upper}`, value)
        }
        if (op === 'live_set_geom_name') {
          const name = args.name
          if (typeof name !== 'string' || !name || new TextEncoder().encode(name).length > 256) throw new WasmEngineError(400, 'Invalid geometry name', 'not_written')
          return live('liveSetGeomName', text('geom_id'), name)
        }
        if (op === 'live_parm_set_update') {
          if (typeof args.value !== 'number' || !Number.isFinite(args.value)) throw new WasmEngineError(400, 'Invalid parameter value', 'not_written')
          return live('liveParmSetUpdate', text('parm_id'), '', args.value as number)
        }
        if (op === 'live_parm_set') {
          if (typeof args.value !== 'number' || !Number.isFinite(args.value)) throw new WasmEngineError(400, 'Invalid parameter value', 'not_written')
          return live('liveParmSet', text('geom_id'), text('key'), args.value as number)
        }
        if (op === 'live_list_analysis') return live('liveListAnalysis')
        if (op === 'live_analysis_input_names') return live('liveAnalysisInputNames', text('analysis'))
        if (op === 'live_analysis_input_type') return live('liveAnalysisInputType', text('analysis'), text('name'))
        if (op === 'live_analysis_defaults') return live('liveAnalysisDefaults', text('analysis'))
        if (op === 'live_analysis_get_int' || op === 'live_analysis_get_double' || op === 'live_analysis_get_string') {
          const index = args.index
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 2147483647) throw new WasmEngineError(400, 'Invalid analysis input index')
          const engineOp = op === 'live_analysis_get_int' ? 'liveAnalysisGetInt' : op === 'live_analysis_get_double' ? 'liveAnalysisGetDouble' : 'liveAnalysisGetString'
          return live(engineOp, text('analysis'), text('name'), index)
        }
        // Length-prefixed UTF-8 packet "<count>;<len>:<bytes>": item 0 is the
        // input name, the rest are the values. Byte lengths keep values with
        // ';', ':' or newlines unambiguous; the engine reads the same framing.
        const packet = (items: string[]): string => {
          const encoder = new TextEncoder()
          return `${items.length};` + items.map(item => `${encoder.encode(item).length}:${item}`).join('')
        }
        const analysisValues = (kind: 'int' | 'double' | 'string'): string[] => {
          const values = args.values
          if (!Array.isArray(values) || values.length > 1024) throw new WasmEngineError(400, 'Invalid analysis input values', 'not_written')
          return values.map(value => {
            if (kind === 'string') {
              if (typeof value !== 'string' || value.includes('\0')) throw new WasmEngineError(400, 'Invalid analysis input', 'not_written')
              return value
            }
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new WasmEngineError(400, 'Invalid analysis input', 'not_written')
            if (kind === 'int' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw new WasmEngineError(400, 'Invalid analysis input', 'not_written')
            return String(value)
          })
        }
        const analysisIndex = (): number => {
          const index = args.index === undefined ? 0 : args.index
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 2147483647) throw new WasmEngineError(400, 'Invalid analysis input index', 'not_written')
          return index
        }
        if (op === 'live_analysis_set_int' || op === 'live_analysis_set_double') {
          const kind = op === 'live_analysis_set_int' ? 'int' : 'double'
          return live(op === 'live_analysis_set_int' ? 'liveAnalysisSetInt' : 'liveAnalysisSetDouble', text('analysis'), packet([text('name'), ...analysisValues(kind)]), analysisIndex())
        }
        if (op === 'live_analysis_set_string') {
          const name = text('name')
          if (name.includes('\0')) throw new WasmEngineError(400, 'Invalid analysis input', 'not_written')
          return live('liveAnalysisSetString', text('analysis'), packet([name, ...analysisValues('string')]), analysisIndex())
        }
        if (op === 'live_analysis_run') return live('liveAnalysisRun', text('analysis'))
        if (op === 'live_parm_info') return live('liveParmInfo', text('parm_id'))
        if (op === 'live_parm_set_by_id') {
          if (typeof args.value !== 'number' || !Number.isFinite(args.value)) throw new WasmEngineError(400, 'Invalid parameter value', 'not_written')
          return live('liveParmSetById', text('parm_id'), '', args.value as number)
        }
        if (op === 'live_xsec_surf_ids') return live('liveXSecSurfIDs', text('geom_id'))
        if (op === 'live_xsec_surfs') return live('liveXSecSurfs', text('geom_id'))
        if (op === 'live_xsec_width') return live('liveXSecWidth', text('xsec_id'))
        if (op === 'live_xsec_height') return live('liveXSecHeight', text('xsec_id'))
        if (op === 'live_xsec_parm') return live('liveXSecParm', text('xsec_id'), text('name'))
        if (op === 'live_xsec_set_width' || op === 'live_xsec_set_height' || op === 'live_xsec_set_width_height') {
          const width = args.width, height = args.height
          if (op !== 'live_xsec_set_height' && (typeof width !== 'number' || !Number.isFinite(width))) throw new WasmEngineError(400, 'Invalid width', 'not_written')
          if (op !== 'live_xsec_set_width' && (typeof height !== 'number' || !Number.isFinite(height))) throw new WasmEngineError(400, 'Invalid height', 'not_written')
          if (op === 'live_xsec_set_width') return live('liveXSecSetWidth', text('xsec_id'), '', width as number)
          if (op === 'live_xsec_set_height') return live('liveXSecSetHeight', text('xsec_id'), '', height as number)
          return live('liveXSecSetWidthHeight', text('xsec_id'), String(height), width as number)
        }
        if (op === 'live_xsecs') return live('liveXSecs', text('xsec_surf_id'))
        if (op === 'live_xsec_ids') return live('liveXSecIDs', text('xsec_surf_id'))
        if (op === 'live_xsec_shape') return live('liveXSecShape', text('xsec_id'))
        if (op === 'live_xsec_parm_ids') return live('liveXSecParmIDs', text('xsec_id'))
        if (op === 'live_xsec_alias' || op === 'live_xsec_curve_alias') {
          return live(op === 'live_xsec_alias' ? 'liveXSecAlias' : 'liveXSecCurveAlias', text('xsec_id'))
        }
        if (op === 'live_xsec_set_alias' || op === 'live_xsec_set_curve_alias') {
          const alias = args.alias
          if (typeof alias !== 'string') throw new WasmEngineError(400, 'Invalid XSec alias', 'not_written')
          return live(op === 'live_xsec_set_alias' ? 'liveXSecSetAlias' : 'liveXSecSetCurveAlias', text('xsec_id'), alias)
        }
        if (op === 'live_xsec_continuity') return live('liveXSecContinuity', text('xsec_id'))
        if (op === 'live_xsec_set_continuity') {
          const continuity = args.continuity
          if (typeof continuity !== 'number' || !Number.isInteger(continuity)) throw new WasmEngineError(400, 'Invalid XSec continuity', 'not_written')
          return live('liveXSecSetContinuity', text('xsec_id'), String(continuity))
        }
        if (op === 'live_xsec_tan_angles' || op === 'live_xsec_tan_slews' || op === 'live_xsec_tan_strengths' || op === 'live_xsec_curvatures') {
          const side = args.side
          if (typeof side !== 'number' || !Number.isInteger(side)) throw new WasmEngineError(400, 'Invalid XSec side', 'not_written')
          const engineOps: Record<string, string> = {
            live_xsec_tan_angles: 'liveXSecTanAngles', live_xsec_tan_slews: 'liveXSecTanSlews',
            live_xsec_tan_strengths: 'liveXSecTanStrengths', live_xsec_curvatures: 'liveXSecCurvatures',
          }
          return live(engineOps[op], text('xsec_id'), '', side)
        }
        if (op === 'live_xsec_set_tan_angles' || op === 'live_xsec_set_tan_slews' || op === 'live_xsec_set_tan_strengths' || op === 'live_xsec_set_curvatures') {
          const side = args.side, fields = args.fields
          if (typeof side !== 'number' || !Number.isInteger(side)) throw new WasmEngineError(400, 'Invalid XSec side', 'not_written')
          if (!Array.isArray(fields) || fields.length !== 4 || fields.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
            throw new WasmEngineError(400, 'Invalid XSec curve values', 'not_written')
          }
          const engineOps: Record<string, string> = {
            live_xsec_set_tan_angles: 'liveXSecSetTanAngles', live_xsec_set_tan_slews: 'liveXSecSetTanSlews',
            live_xsec_set_tan_strengths: 'liveXSecSetTanStrengths', live_xsec_set_curvatures: 'liveXSecSetCurvatures',
          }
          return live(engineOps[op], text('xsec_id'), [side, ...fields].join('\x1f'))
        }
        const int32 = (key: string, fallback?: number): number => {
          const value = args[key] === undefined ? fallback : args[key]
          if (typeof value !== 'number' || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
            throw new WasmEngineError(400, `Invalid ${key}`, 'not_written')
          }
          return value
        }
        if (op === 'live_insert_xsec') {
          return live('liveInsertXSec', text('geom_id'), String(int32('shape')), int32('index'))
        }
        if (op === 'live_insert_xsec_by_id') {
          return live('liveInsertXSecByID', text('xsec_id'), String(int32('shape')))
        }
        if (op === 'live_delete_xsec') {
          return live('liveDeleteXSec', text('xsec_surf_id'), '', int32('index'))
        }
        if (op === 'live_delete_xsec_by_id') {
          return live('liveDeleteXSecByID', text('xsec_id'))
        }
        if (op === 'live_copy_xsec') return live('liveCopyXSec', text('geom_id'), '', int32('index'))
        if (op === 'live_copy_xsec_by_id') return live('liveCopyXSecByID', text('xsec_id'))
        if (op === 'live_paste_xsec') return live('livePasteXSec', text('geom_id'), '', int32('index'))
        if (op === 'live_paste_xsec_by_id') return live('livePasteXSecByID', text('xsec_id'))
        if (op === 'live_change_xsec_shape') {
          return live('liveChangeXSecShape', text('xsec_id'), String(int32('shape')))
        }
        if (op === 'live_sub_surfs') return live('liveSubSurfs', text('geom_id'))
        if (op === 'live_sub_surfs_by_name') return live('liveSubSurfsByName', text('geom_id'), text('name'))
        if (op === 'live_sub_surf_type') return live('liveSubSurfType', text('sub_id'))
        if (op === 'live_sub_surf_parm_ids') return live('liveSubSurfParmIDs', text('sub_id'))
        if (op === 'live_sub_surf_name') {
          const subId = text('sub_id')
          const geomId = args.geom_id
          return geomId === undefined ? live('liveSubSurfName', subId) : live('liveSubSurfNameGeom', text('geom_id'), subId)
        }
        if (op === 'live_sub_surf_index') return live('liveSubSurfIndex', text('sub_id'))
        if (op === 'live_all_sub_surfs') return live('liveAllSubSurfs')
        if (op === 'live_add_sub_surf') {
          return live('liveAddSubSurf', text('geom_id'), String(int32('type')), int32('surf_index', 0))
        }
        if (op === 'live_delete_sub_surf') {
          return args.geom_id === undefined ? live('liveDeleteSubSurfID', text('sub_id')) : live('liveDeleteSubSurf', text('geom_id'), text('sub_id'))
        }
        if (op === 'live_reorder_sub_surf') return live('liveReorderSubSurf', text('geom_id'), text('sub_id'), int32('reorder_type'))
        if (op === 'live_set_sub_surf_name') {
          const name = text('name')
          if (args.geom_id === undefined) return live('liveSetSubSurfNameID', text('sub_id'), name)
          return live('liveSetSubSurfName', text('geom_id'), `${text('sub_id')}\x1f${name}`)
        }
        if (op === 'live_num_sets') return live('liveNumSets')
        if (op === 'live_set_name') return live('liveSetName', '', '', Number(args.index))
        if (op === 'live_set_set_name') return live('liveSetSetName', '', text('name'), Number(args.index))
        if (op === 'live_set_index') return live('liveSetIndex', text('name'))
        if (op === 'live_geom_set') return live('liveGeomSet', text('name'))
        if (op === 'live_geom_set_at_index') {
          const index = args.index
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw new WasmEngineError(400, 'Invalid set index', 'not_written')
          return live('liveGeomSetAtIndex', '', '', index)
        }
        if (op === 'live_get_set_flag') return live('liveGetSetFlag', text('geom_id'), '', Number(args.set_index))
        if (op === 'live_set_set_flag') return live('liveSetSetFlag', text('geom_id'), args.flag ? '1' : '0', Number(args.set_index))
        if (op === 'live_result_names') return live('liveResultNames', text('result_id'))
        if (op === 'live_result_name') return live('liveResultName', text('result_id'))
        if (op === 'live_result_num_data') return live('liveResultNumData', text('result_id'), text('name'))
        if (op === 'live_result_type') return live('liveResultType', text('result_id'), text('name'))
        if (op === 'live_results_ids') return live('liveResultsIds')
        if (op === 'live_results_names') return live('liveResultsNames')
        if (op === 'live_find_results_id') {
          const index = args.index
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw new WasmEngineError(400, 'Invalid result index', 'not_written')
          return live('liveFindResultsId', text('name'), '', index)
        }
        if (op === 'live_find_latest_results_id') return live('liveFindLatestResultsId', text('name'))
        if (op === 'live_num_results') return live('liveNumResults', text('name'))
        if (op === 'live_delete_result') return live('liveDeleteResult', text('result_id'))
        if (op === 'live_delete_all_results') return live('liveDeleteAllResults')
        if (op === 'live_result_binary_field') {
          const name = text('name')
          if (name.includes('\x1f')) throw new WasmEngineError(400, 'Invalid result field', 'not_written')
          const integer = (key: string, max: number) => {
            const n = args[key]
            if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max) throw new WasmEngineError(400, `Invalid ${key}`, 'not_written')
            return n
          }
          const index = integer('index', 0x7fffffff), row = integer('row', 0xffffffff), offset = integer('offset', 0xffffffff)
          return live('liveResultBinaryField', text('result_id'), `${name}\x1f${row}\x1f${offset}`, index)
        }
        if (op === 'live_result_object') return live('liveResultObject', text('result_id'))
        if (op === 'live_result_tree') throw new WasmEngineError(400, 'Result tree batching is disabled until bounded and lossless', 'not_written')
        if (op === 'live_result_objects_capabilities') return live('liveResultObjectsCapabilities')
        if (op === 'live_result_objects') {
          const ids = args.result_ids
          if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 || ids.some((id) => typeof id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(id))) {
            throw new WasmEngineError(400, 'Invalid result ID list', 'not_written')
          }
          return live('liveResultObjects', ids.join('\x1f'))
        }
        if (op === 'live_result_shape') return live('liveResultShape', text('result_id'), text('name'), Number(args.index ?? 0))
        throw new Error('Unsupported live operation')
      }
      throw new Error('Unsupported synchronous operation')
    }
    worker.onerror = (event) => finish(new Error(`Sync worker failed: ${event.message}`))
    worker.onmessageerror = () => finish(new Error('Invalid sync worker message'))
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; op?: string; args?: string; value?: string; stdout?: string; ok?: boolean; id?: number; error?: string; buffer?: SharedArrayBuffer; capacity?: number; profile?: ConsoleProfile; path?: string; name?: string }
      if (mode === 'console' && msg.type === 'ready') {
        clearTimeout(timer) // The session stays open until it is closed.
        resolve({
          run: (code: string, profile = false) => new Promise((res, rej) => {
            const runId = ++consoleRunId
            consoleRuns.set(runId, { resolve: res, reject: rej })
            worker.postMessage({ type: 'run', id: runId, code, profile })
          }),
          close: () => { finished = true; worker.terminate() },
        })
        return
      }
      if (mode === 'console' && msg.type === 'result') {
        const entry = consoleRuns.get(msg.id ?? -1)
        if (!entry) return
        consoleRuns.delete(msg.id ?? -1)
        entry.resolve({ ok: !!msg.ok, value: msg.value ?? '', stdout: msg.stdout ?? '', error: msg.error, profile: msg.profile })
        return
      }
      if (msg.type === 'file_open') {
        void openEngineFile().then(
          (path) => worker.postMessage({ type: 'file_open_result', id: msg.id, value: path }),
          (error: unknown) => worker.postMessage({ type: 'file_open_result', id: msg.id, error: error instanceof Error ? error.message : String(error) }),
        )
        return
      }
      if (msg.type === 'file_save') {
        void saveEngineFile(String(msg.path ?? ''), msg.name ? String(msg.name) : undefined).then(
          () => worker.postMessage({ type: 'file_save_result', id: msg.id, value: null }),
          (error: unknown) => worker.postMessage({ type: 'file_save_result', id: msg.id, error: error instanceof Error ? error.message : String(error) }),
        )
        return
      }
      if (msg.type === 'done') {
        try { finish(undefined, JSON.parse(msg.value ?? '')) } catch { finish(new Error('Invalid sync result')) }
        return
      }
      if (msg.type === 'failed') return finish(new Error(msg.error ?? 'Sync worker failed'))
      if (msg.type === 'abandon') { poisoned = true; return }
      const capacity = typeof msg.capacity === 'number' ? msg.capacity : MAX_BYTES
      if (msg.type !== 'request' || !(msg.buffer instanceof SharedArrayBuffer) || msg.buffer.byteLength !== RESPONSE_HEADER_BYTES + capacity) return finish(new Error('Invalid sync request'))
      const buffer = msg.buffer
      void (async () => {
        let response: unknown
        let binaryResponse: ArrayBuffer | undefined
        try {
          if (active || poisoned) throw new WasmEngineError(400, 'A previous request is unresolved or timed out; do not retry dispatched operations', 'not_written')
          active = true
          currentWriteIssued = false
          try {
            const args = JSON.parse(msg.args ?? '{}') as Record<string, unknown>
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments')
            const value = await dispatch(msg.op ?? '', args)
            if ((msg.op === 'live_result_binary_field' || msg.op === 'live_result_object' || msg.op === 'live_result_objects') && value instanceof ArrayBuffer) binaryResponse = value
            response = { ok: true, value }
          } finally { active = false }
        } catch (error) {
          const write = isWrite(msg.op ?? '')
          const details = error instanceof WasmEngineError ? { outcome: error.outcome ?? (write ? (currentWriteIssued ? 'unknown' : 'not_written') : undefined), actual: error.actual, code: error.code } : { outcome: write ? (currentWriteIssued ? 'unknown' : 'not_written') : undefined }
          const message = error instanceof Error ? error.message : String(error)
          response = { ok: false, error: { message, ...(message === 'Unsupported live operation' ? { code: 'UNSUPPORTED_OPERATION' } : {}), ...details } }
        }
        if (finished) return
        const write = isWrite(msg.op ?? '')
        const control = new Int32Array(buffer, 0, 2)
        let bytes: Uint8Array
        try {
          if (binaryResponse && binaryResponse.byteLength <= capacity) {
            bytes = new Uint8Array(binaryResponse)
            // A negative length distinguishes the binary payload from UTF-8 JSON.
            new Uint8Array(buffer, RESPONSE_HEADER_BYTES).set(bytes)
            Atomics.store(control, 1, -bytes.length)
            Atomics.store(control, 0, 1)
            Atomics.notify(control, 0)
            return
          }
          bytes = binaryResponse ? new TextEncoder().encode(responseTooLarge(false, false, capacity)) : encodeResponse(response, write, currentWriteIssued, capacity)
          new Uint8Array(buffer, RESPONSE_HEADER_BYTES).set(bytes)
        } catch (error) {
          // Never leave the waiting Python thread without an answer.
          const message = `Synchronous response could not be delivered: ${error instanceof Error ? error.message : String(error)}`
          bytes = new TextEncoder().encode(JSON.stringify({ ok: false, error: { message, code: 'TRANSPORT_WRITE_FAILED', ...(write ? { outcome: currentWriteIssued ? 'unknown' : 'not_written' } : {}) } }))
          if (bytes.length > capacity) bytes = bytes.slice(0, capacity)
          new Uint8Array(buffer, RESPONSE_HEADER_BYTES, bytes.length).set(bytes)
        }
        Atomics.store(control, 1, bytes.length)
        Atomics.store(control, 0, 1)
        Atomics.notify(control, 0)
      })()
    }
    worker.postMessage({ assets, mode, script })
  })
}
