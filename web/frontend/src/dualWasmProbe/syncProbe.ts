import { callGuarded, syncProbeEngineCall, syncProbeFileExperiment, wasmRequest, WasmEngineError } from '../api/wasmEngine'
import { SYNC_API } from './syncApi.generated'

type Geom = { id: string; name: string; type: string }
type Model = { geoms: Geom[]; modelEpoch: string; modelEpochValid: boolean }
const MAX_BYTES = 64 * 1024
const RESPONSE_HEADER_BYTES = 8

function responseTooLarge(write: boolean, issued: boolean): string {
  return JSON.stringify({ ok: false, error: { message: 'Synchronous response exceeds 65536-byte limit', code: 'RESPONSE_TOO_LARGE', ...(write ? { outcome: issued ? 'unknown' : 'not_written' } : {}) } })
}
function encodeResponse(response: unknown, write: boolean, issued: boolean): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(response))
  if (encoded.length <= MAX_BYTES) return encoded
  const fallback = new TextEncoder().encode(responseTooLarge(write, issued))
  if (fallback.length > MAX_BYTES) throw new Error('Response overflow fallback exceeds transport limit')
  return fallback
}

/** Fixed, read-only opt-in diagnostic. */
export function runSyncProbe(): Promise<unknown> { return run('read') }
/** Fixed diagnostic that creates and modifies one root wing. */
export function runSyncModelingProbe(): Promise<unknown> { return run('modeling') }

async function run(mode: 'read' | 'modeling'): Promise<unknown> {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Cross-origin isolation and SharedArrayBuffer are required')
  const worker = new Worker(new URL('./syncWorker.ts', import.meta.url), { type: 'module' })
  const assets = new URL(`${import.meta.env.BASE_URL}pyodide/`, window.location.href).href
  return new Promise((resolve, reject) => {
    let finished = false
    let active = false
    let poisoned = false
    let dispatchedWrite = false
    let currentWriteIssued = false
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
      const msg = event.data as { type?: string; op?: string; args?: string; value?: string; error?: string; buffer?: SharedArrayBuffer }
      if (msg.type === 'done') {
        try { finish(undefined, JSON.parse(msg.value ?? '')) } catch { finish(new Error('Invalid sync result')) }
        return
      }
      if (msg.type === 'failed') return finish(new Error(msg.error ?? 'Sync worker failed'))
      if (msg.type === 'abandon') { poisoned = true; return }
      if (msg.type !== 'request' || !(msg.buffer instanceof SharedArrayBuffer) || msg.buffer.byteLength !== RESPONSE_HEADER_BYTES + MAX_BYTES) return finish(new Error('Invalid sync request'))
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
        try {
          if (active || poisoned) throw new WasmEngineError(400, 'A previous request is unresolved or timed out; do not retry dispatched operations', 'not_written')
          active = true
          currentWriteIssued = false
          try {
            const args = JSON.parse(msg.args ?? '{}') as Record<string, unknown>
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments')
            response = { ok: true, value: await dispatch(msg.op ?? '', args) }
          } finally { active = false }
        } catch (error) {
          const write = SYNC_API.some((entry) => entry.operation === msg.op && entry.write)
          const details = error instanceof WasmEngineError ? { outcome: error.outcome ?? (write ? (currentWriteIssued ? 'unknown' : 'not_written') : undefined), actual: error.actual, code: error.code } : { outcome: write ? (currentWriteIssued ? 'unknown' : 'not_written') : undefined }
          response = { ok: false, error: { message: error instanceof Error ? error.message : String(error), ...details } }
        }
        if (finished) return
        const write = SYNC_API.some((entry) => entry.operation === (msg.op ?? '') && entry.write)
        const bytes = encodeResponse(response, write, currentWriteIssued)
        new Uint8Array(buffer, RESPONSE_HEADER_BYTES).set(bytes)
        const control = new Int32Array(buffer, 0, 2)
        Atomics.store(control, 1, bytes.length)
        Atomics.store(control, 0, 1)
        Atomics.notify(control, 0)
      })()
    }
    worker.postMessage({ assets, mode })
  })
}
