import { callGuarded, syncProbeEngineCall, syncProbeFileExperiment, wasmRequest, WasmEngineError } from '../api/wasmEngine'
import { SYNC_API } from './syncApi.generated'

type Geom = { id: string; name: string; type: string }
type Model = { geoms: Geom[]; modelEpoch: string; modelEpochValid: boolean }
const MAX_BYTES = 64 * 1024
const RESPONSE_HEADER_BYTES = 8

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

/** Fixed, read-only opt-in diagnostic. */
export function runSyncProbe(): Promise<unknown> { return run('read') }
/** Fixed diagnostic that creates and modifies one root wing. */
export function runSyncModelingProbe(): Promise<unknown> { return run('modeling') }

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

async function run(mode: 'read' | 'modeling' | 'script' | 'console', script?: string): Promise<unknown> {
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
    let epoch: string | undefined
    const parameterIds = new Map<string, Map<string, string>>()
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      worker.terminate()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error(dispatchedWrite ? 'Synchronous probe timed out after a write was dispatched; its outcome may be unknown. Do not retry automatically.' : 'Synchronous probe timed out before a model write was dispatched.')), 120_000)
    async function model(): Promise<Model> {
      const result = await wasmRequest('GET', '/model') as Model
      if (!result.modelEpochValid || !result.modelEpoch) throw new Error('Model identity unavailable')
      if (epoch !== undefined && epoch !== result.modelEpoch) throw new Error('Model was replaced during probe')
      epoch = result.modelEpoch
      return result
    }
    async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
      const spec = SYNC_API.find((entry) => entry.operation === op)
      if (spec) {
        const valid = Object.keys(args).length === spec.arguments.length && spec.arguments.every((arg) => {
          const value = args[arg.wire]
          if (arg.type === 'string') return typeof value === 'string'
          if (arg.type === 'boolean') return typeof value === 'boolean'
          if (arg.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
          return typeof value === 'number' && Number.isFinite(value)
        })
        if (!valid) throw new WasmEngineError(400, 'Invalid synchronous API arguments', 'not_written')
      }
      if (op === 'timeout_real_test') {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return 'late'
      }
      if (op === 'ping_slow') {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return 'ok'
      }
      if (op === 'setup') {
        const current = await model()
        const wing = current.geoms.find((g) => g.type === 'Wing')
        if (!wing) throw new Error('Add a wing in WebVSP before running this read-only probe')
        return { id: wing.id, name: wing.name, nameUnique: current.geoms.filter((g) => g.name === wing.name).length === 1 }
      }
      if (op === 'find_geoms') return (await model()).geoms.map((g) => g.id)
      if (op === 'geom_name' || op === 'geom_type') {
        if (typeof args.geom_id !== 'string' || !args.geom_id) throw new WasmEngineError(400, 'Geometry ID is required', 'not_written')
        const geom = (await model()).geoms.find((g) => g.id === args.geom_id)
        if (!geom) throw new WasmEngineError(404, 'Geometry not found', 'not_written')
        return op === 'geom_name' ? geom.name : geom.type
      }
      if (op === 'find_geom') {
        if (typeof args.name !== 'string' || typeof args.index !== 'number' || !Number.isSafeInteger(args.index)) throw new Error('Invalid geometry name or index')
        return (await model()).geoms.filter((g) => g.name === args.name)[args.index]?.id ?? ''
      }
      if (op === 'set_geom_name') {
        if (mode !== 'modeling' || typeof args.geom_id !== 'string' || typeof args.name !== 'string' || !args.name || args.name.length > 256) throw new WasmEngineError(400, 'Only non-empty geometry names up to 256 characters are supported', 'not_written')
        const current = await model()
        const geom = current.geoms.find((g) => g.id === args.geom_id)
        if (!geom) throw new WasmEngineError(404, 'Geometry not found', 'not_written')
        if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
        dispatchedWrite = true
        currentWriteIssued = true
        await callGuarded('guardedSetGeomName', args.geom_id, args.name, 0, epoch!)
        return null
      }
      if (op === 'delete_geom') {
        if (mode !== 'modeling' || typeof args.geom_id !== 'string' || !args.geom_id) throw new WasmEngineError(400, 'A geometry ID is required', 'not_written')
        if (!(await model()).geoms.some((g) => g.id === args.geom_id)) throw new WasmEngineError(404, 'Geometry not found', 'not_written')
        if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
        dispatchedWrite = true
        currentWriteIssued = true
        await callGuarded('guardedDeleteGeom', args.geom_id, '', 0, epoch!)
        return null
      }
      if (op === 'add_geom') {
        if (mode !== 'modeling' || args.type !== 'WING' || args.parent !== '') throw new WasmEngineError(400, 'Only a root WING is supported', 'not_written')
        await model()
        if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
        dispatchedWrite = true
        currentWriteIssued = true
        const result = await callGuarded<{ id: string }>('addGeom', 'WING', '', 0, epoch!)
        // Selection is a separate UI operation; never label its failure as a failed creation.
        try {
          if (finished || poisoned) throw new Error('Probe stopped after creation')
          await wasmRequest('POST', '/pick', { id: result.id })
        }
        catch { throw new WasmEngineError(500, `Wing ${result.id} was created, but selection refresh failed`, 'unknown') }
        return result.id
      }
      if (op === 'update') {
        if (mode !== 'modeling' || args.update_managers !== true) throw new WasmEngineError(400, 'Only Update(True) is supported', 'not_written')
        await model()
        if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
        dispatchedWrite = true
        currentWriteIssued = true
        return callGuarded('guardedUpdate', '', '', 0, epoch!)
      }
      if (op === 'parm_value' || op === 'set_parm') {
        const allowed = (args.group === 'WingGeom' && typeof args.name === 'string' && ['TotalArea', 'TotalSpan', 'TotalChord'].includes(args.name)) || (args.group === 'XForm' && args.name === 'X_Rel_Location')
        if (typeof args.geom !== 'string' || !args.geom || !allowed || (op === 'set_parm' && (mode !== 'modeling' || args.group !== 'XForm' || typeof args.value !== 'number' || !Number.isFinite(args.value)))) throw new WasmEngineError(400, 'Unsupported parameter query or write', 'not_written')
        const current = await model()
        if (!current.geoms.some((g) => g.id === args.geom && g.type === 'Wing')) throw new Error('Wing not found in current model')
        let matches = parameterIds.get(args.geom)
        if (!matches) {
          const ids = await callGuarded<string[]>('geomParmIDs', args.geom, '', 0, epoch!)
          if (new Set(ids).size !== ids.length) throw new Error('Duplicate parameter ID')
          matches = new Map<string, string>()
          for (const id of ids) {
            if (finished || poisoned) throw new Error('Probe stopped')
            const p: { name: string; group: string; container: string } = await callGuarded('geomParm', args.geom, id, 0, epoch!)
            if (p.container === args.geom && ((p.group === 'WingGeom' && ['TotalArea', 'TotalSpan', 'TotalChord'].includes(p.name)) || (p.group === 'XForm' && p.name === 'X_Rel_Location'))) {
              const key = `${p.group}/${p.name}`
              if (matches.has(key)) throw new Error('Ambiguous parameter')
              matches.set(key, id)
            }
          }
          if (matches.size !== 4) throw new Error('Required parameter not found')
          parameterIds.set(args.geom, matches)
        }
        const parmId = matches.get(`${args.group}/${args.name}`)
        if (!parmId) throw new Error('Parameter not found')
        const p: { name: string; group: string; container: string; value: number | null } = await callGuarded('geomParm', args.geom, parmId, 0, epoch!)
        if (p.name !== args.name || p.group !== args.group || p.container !== args.geom || typeof p.value !== 'number' || !Number.isFinite(p.value)) throw new Error('Parameter changed or is invalid')
        if (op === 'set_parm') {
          if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
          dispatchedWrite = true
          currentWriteIssued = true
          const result = await callGuarded<{ actual: number }>('geomSetParm', args.geom, parmId, args.value as number, epoch!)
          return result.actual
        }
        return p.value
      }
      if (op === 'geom_parm_ids') {
        if (typeof args.geom_id !== 'string' || !args.geom_id) throw new WasmEngineError(400, 'Geometry ID is required', 'not_written')
        await model()
        return callGuarded('geomParmIDs', args.geom_id, '', 0, epoch!)
      }
      if (op === 'parm_value_id' || op === 'parm_int_value_id' || op === 'parm_name_id' || op === 'parm_type_id') {
        if (typeof args.parm_id !== 'string' || !args.parm_id) throw new WasmEngineError(400, 'Parameter ID is required', 'not_written')
        await model()
        if (finished || poisoned) throw new WasmEngineError(400, 'Probe stopped', 'not_written')
        const engineOp: 'parm_value_id' | 'parm_int_value_id' | 'parm_name_id' | 'parm_type_id' = op === 'parm_value_id' ? 'parm_value_id' : op === 'parm_int_value_id' ? 'parm_int_value_id' : op === 'parm_name_id' ? 'parm_name_id' : 'parm_type_id'
        return callGuarded(engineOp, args.parm_id, '', 0, epoch!)
      }
      if ((mode === 'script' || mode === 'console') && op.startsWith('live_')) {
        const live = (engineOp: string, a = '', b = '', value = 0) => syncProbeEngineCall(engineOp, a, b, value)
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
        if (op === 'live_delete_geom') {
          await live('deleteGeoms', text('geom_id'))
          return null
        }
        if (op === 'live_update') {
          await live('liveUpdate')
          return null
        }
        if (op === 'live_parm_get') {
          return live('liveParmGet', text('geom_id'), text('key'))
        }
        if (op === 'live_parm_set') {
          if (typeof args.value !== 'number' || !Number.isFinite(args.value)) throw new WasmEngineError(400, 'Invalid parameter value', 'not_written')
          return live('liveParmSet', text('geom_id'), text('key'), args.value as number)
        }
        if (op === 'live_analysis_defaults') return live('liveAnalysisDefaults', text('analysis'))
        if (op === 'live_analysis_set_int') {
          if (typeof args.value !== 'number' || !Number.isSafeInteger(args.value)) throw new WasmEngineError(400, 'Invalid analysis input value', 'not_written')
          return live('liveAnalysisSetInt', text('analysis'), text('name'), args.value as number)
        }
        if (op === 'live_analysis_run') return live('liveAnalysisRun', text('analysis'))
        if (op === 'live_results_ids') return live('liveResultsIds')
        if (op === 'live_result_tree') throw new WasmEngineError(400, 'Result tree batching is disabled until bounded and lossless', 'not_written')
        if (op === 'live_result_object') return live('liveResultObject', text('result_id'))
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
        if (op === 'live_result_names') return live('liveResultNames', text('result_id'))
        if (op === 'live_result_name') return live('liveResultName', text('result_id'))
        if (op === 'live_result_num_data') return live('liveResultNumData', text('result_id'), text('name'))
        if (op === 'live_result_type') return live('liveResultType', text('result_id'), text('name'))
        if (op === 'live_xsec_surfs') return live('liveXSecSurfs', text('geom_id'))
        if (op === 'live_xsecs') return live('liveXSecs', text('xsec_surf_id'))
        if (op === 'live_xsec_shape') return live('liveXSecShape', text('xsec_id'))
        if (op === 'live_xsec_parm_ids') return live('liveXSecParmIDs', text('xsec_id'))
        if (op === 'live_insert_xsec') {
          if (typeof args.index !== 'number' || typeof args.shape !== 'number') throw new WasmEngineError(400, 'Invalid XSec index or shape', 'not_written')
          return live('liveInsertXSec', text('geom_id'), String(args.shape), args.index)
        }
        if (op === 'live_delete_xsec') {
          if (typeof args.index !== 'number') throw new WasmEngineError(400, 'Invalid XSec index', 'not_written')
          return live('liveDeleteXSec', text('xsec_surf_id'), '', args.index)
        }
        if (op === 'live_change_xsec_shape') {
          if (typeof args.shape !== 'number') throw new WasmEngineError(400, 'Invalid XSec shape', 'not_written')
          return live('liveChangeXSecShape', text('xsec_id'), String(args.shape))
        }
        if (op === 'live_sub_surfs') return live('liveSubSurfs', text('geom_id'))
        if (op === 'live_add_sub_surf') {
          if (typeof args.type !== 'number') throw new WasmEngineError(400, 'Invalid subsurface type', 'not_written')
          return live('liveAddSubSurf', text('geom_id'), String(args.type), Number(args.surf_index ?? 0))
        }
        if (op === 'live_delete_sub_surf') return live('liveDeleteSubSurf', text('geom_id'), text('sub_id'))
        if (op === 'live_num_sets') return live('liveNumSets')
        if (op === 'live_set_name') return live('liveSetName', '', '', Number(args.index))
        if (op === 'live_set_set_name') return live('liveSetSetName', '', text('name'), Number(args.index))
        if (op === 'live_get_set_flag') return live('liveGetSetFlag', text('geom_id'), '', Number(args.set_index))
        if (op === 'live_set_set_flag') return live('liveSetSetFlag', text('geom_id'), args.flag ? '1' : '0', Number(args.set_index))
        if (op === 'live_parm_info') return live('liveParmInfo', text('parm_id'))
        if (op === 'live_parm_set_by_id') {
          if (typeof args.value !== 'number' || !Number.isFinite(args.value)) throw new WasmEngineError(400, 'Invalid parameter value', 'not_written')
          return live('liveParmSetById', text('parm_id'), '', args.value as number)
        }
        if (op === 'live_result_shape') return live('liveResultShape', text('result_id'), text('name'), Number(args.index ?? 0))
        if (op === 'live_result_values') {
          if (typeof args.index !== 'number' || !Number.isSafeInteger(args.index) || args.index < 0) throw new WasmEngineError(400, 'Invalid result index', 'not_written')
          return live('liveResultValues', text('result_id'), text('name'), args.index as number)
        }
        throw new Error('Unsupported live operation')
      }
      if (op === 'results_fixture_open') return syncProbeEngineCall('results_fixture_open')
      if (op === 'results_fixture_close') return syncProbeEngineCall('results_fixture_close', String(args.fixture_token ?? ''))
      if (op === 'results_fixture_data_names') return syncProbeEngineCall('results_fixture_data_names', String(args.fixture_token ?? ''))
      if (op === 'results_fixture_name') return syncProbeEngineCall('results_fixture_name', String(args.fixture_token ?? ''))
      if (op === 'results_fixture_type') return syncProbeEngineCall('results_fixture_type', String(args.fixture_token ?? ''), String(args.data_name ?? ''))
      if (op === 'results_fixture_int') return syncProbeEngineCall('results_fixture_int', String(args.fixture_token ?? ''), String(args.data_name ?? ''), Number(args.index ?? 0))
      if (op === 'results_fixture_double') return syncProbeEngineCall('results_fixture_double', String(args.fixture_token ?? ''), String(args.data_name ?? ''), Number(args.index ?? 0))
      if (op === 'results_fixture_string') return syncProbeEngineCall('results_fixture_string', String(args.fixture_token ?? ''), String(args.data_name ?? ''), Number(args.index ?? 0))
      if (op === 'results_fixture_matrix') return syncProbeEngineCall('results_fixture_matrix', String(args.fixture_token ?? ''), String(args.data_name ?? ''), Number(args.index ?? 0))
      if (op === 'results_fixture_vec3d') return syncProbeEngineCall('results_fixture_vec3d', String(args.fixture_token ?? ''), String(args.data_name ?? ''), Number(args.index ?? 0))
      if (op === 'file_roundtrip') {
        if (args.text !== 'python-to-openvsp\n') throw new Error('Unsupported file content')
        return syncProbeFileExperiment(args.text)
      }
      throw new Error('Unsupported synchronous probe operation')
    }
    worker.onerror = (event) => finish(new Error(`Sync worker failed: ${event.message}`))
    worker.onmessageerror = () => finish(new Error('Invalid sync worker message'))
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; op?: string; args?: string; value?: string; stdout?: string; ok?: boolean; id?: number; error?: string; buffer?: SharedArrayBuffer; capacity?: number; profile?: ConsoleProfile }
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
      if (msg.type === 'done') {
        try { finish(undefined, JSON.parse(msg.value ?? '')) } catch { finish(new Error('Invalid sync result')) }
        return
      }
      if (msg.type === 'failed') return finish(new Error(msg.error ?? 'Sync worker failed'))
      if (msg.type === 'abandon') { poisoned = true; return }
      const capacity = typeof msg.capacity === 'number' ? msg.capacity : MAX_BYTES
      if (msg.type !== 'request' || !(msg.buffer instanceof SharedArrayBuffer) || msg.buffer.byteLength !== RESPONSE_HEADER_BYTES + capacity) return finish(new Error('Invalid sync request'))
      const buffer = msg.buffer
      if (msg.op === 'timeout_test') {
        setTimeout(() => {
          const bytes = new TextEncoder().encode('{"ok":true,"value":"late"}')
          new Uint8Array(buffer, RESPONSE_HEADER_BYTES).set(bytes)
          const control = new Int32Array(buffer, 0, 2)
          Atomics.store(control, 1, bytes.length)
          Atomics.store(control, 0, 1)
          Atomics.notify(control, 0)
        }, 100)
        return
      }
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
            if ((msg.op === 'live_result_binary_field' || msg.op === 'live_result_object') && value instanceof ArrayBuffer) binaryResponse = value
            response = { ok: true, value }
          } finally { active = false }
        } catch (error) {
          const write = SYNC_API.some((entry) => entry.operation === msg.op && entry.write)
          const details = error instanceof WasmEngineError ? { outcome: error.outcome ?? (write ? (currentWriteIssued ? 'unknown' : 'not_written') : undefined), actual: error.actual, code: error.code } : { outcome: write ? (currentWriteIssued ? 'unknown' : 'not_written') : undefined }
          response = { ok: false, error: { message: error instanceof Error ? error.message : String(error), ...details } }
        }
        if (finished) return
        const write = SYNC_API.some((entry) => entry.operation === (msg.op ?? '') && entry.write)
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
