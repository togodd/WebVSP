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
  'live_change_xsec_shape', 'live_add_sub_surf', 'live_delete_sub_surf',
  'live_reorder_sub_surf', 'live_set_sub_surf_name', 'live_set_set_name', 'live_set_set_flag', 'live_delete_result', 'live_delete_all_results',
  'live_parm_set_update', 'live_set_geom_name',
  'live_update_geom', 'live_set_geom_parent', 'live_copy_geom', 'live_cut_geom', 'live_paste_geom',
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
        if (op === 'live_comp_pnt01' || op === 'live_comp_norm01') {
          const id = text('geom_id'), index = args.surf_indx, u = args.u, w = args.w
          if (typeof index !== 'number' || !Number.isInteger(index) || index < -2147483648 || index > 2147483647) throw new WasmEngineError(400, 'Invalid surf_indx')
          if (typeof u !== 'number' || !Number.isFinite(u) || typeof w !== 'number' || !Number.isFinite(w)) throw new WasmEngineError(400, 'Invalid surface coordinate')
          return live(op === 'live_comp_pnt01' ? 'liveCompPnt01' : 'liveCompNorm01', id, `${index},${w}`, u)
        }
        if (op === 'live_num_main_surfs') return live('liveNumMainSurfs', text('geom_id'))
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
