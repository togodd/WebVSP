import { callGuarded, wasmRequest, WasmEngineError } from '../api/wasmEngine'

export interface ProbeResult {
  python: string
  beforeCount: number
  wingId: string
  afterCount: number
  error: string
  errorOutcome: string
  parameterId: string
  parameterName: string
  parameterGroup: string
  parameterCount: number
  oldValue: number
  requestedValue: number
  actualValue: number
  readback: number
  unsupportedError: string
}

type Geom = { id: string; name: string; type: string }
type Model = { geoms: Geom[]; modelEpoch: string; modelEpochValid: boolean }


/** Run a fixed diagnostic against this page's existing engine, never arbitrary Python. */
export function runDualWasmProbe(): Promise<ProbeResult> {
  const assets = new URL(`${import.meta.env.BASE_URL}pyodide/`, window.location.href).href
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let finished = false
    let dispatched = false
    let epoch: string | undefined
    let active = false

    async function model(): Promise<Model> {
      const result = await wasmRequest('GET', '/model') as Model
      if (!result.modelEpochValid || typeof result.modelEpoch !== 'string') throw new Error('Model identity unavailable')
      if (epoch !== undefined && result.modelEpoch !== epoch) throw new Error('Model was replaced during the probe')
      epoch = result.modelEpoch
      return result
    }

    function id(value: unknown): string {
      if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid identifier')
      return value
    }

    async function dispatch(op: string | undefined, raw: string | undefined): Promise<unknown> {
      const args = JSON.parse(raw ?? '{}') as Record<string, unknown>
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments')
      if (op === 'find_geoms') return (await model()).geoms.map((geom) => geom.id)
      if (op === 'geom_name' || op === 'geom_type') {
        const geom = (await model()).geoms.find((item) => item.id === id(args.geom_id))
        if (!geom) throw new Error('Geometry not found')
        return op === 'geom_name' ? geom.name : geom.type
      }
      if (epoch === undefined) throw new Error('Read the model before using this operation')
      if (op === 'add_geom') {
        if (args.geom_type !== 'WING' || args.parent !== '') throw new Error('Only root WING creation is supported')
        dispatched = true
        const result = await callGuarded<{ id: string }>('addGeom', 'WING', '', 0, epoch)
        // Refresh the mirrored browser through its usual selection path.
        await wasmRequest('POST', '/pick', { id: result.id })
        return result.id
      }
      if (op === 'parm_ids') return callGuarded('geomParmIDs', id(args.geom_id), '', 0, epoch)
      if (op === 'parm') return callGuarded('geomParm', id(args.geom_id), id(args.parm_id), 0, epoch)
      if (op === 'set_parm') {
        if (typeof args.value !== 'number' || !Number.isFinite(args.value)) throw new WasmEngineError(400, 'Parameter value must be finite', 'not_written')
        dispatched = true
        const result = await callGuarded<{ actual: number }>('geomSetParm', id(args.geom_id), id(args.parm_id), args.value, epoch)
        return result.actual
      }
      throw new Error('Unsupported probe operation')
    }
    const finish = (error?: Error, value?: ProbeResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      worker.terminate()
      if (error) reject(error)
      else resolve(value!)
    }
    const timer = setTimeout(() => finish(new Error(dispatched
      ? 'Probe timed out after a write was dispatched; its outcome may be unknown. Do not automatically retry.'
      : 'Probe timed out before a write was dispatched.')), 120_000)
    worker.onerror = (event) => finish(new Error(`Pyodide worker failed: ${event.message}`))
    worker.onmessageerror = () => finish(new Error('Pyodide worker sent an unreadable message'))
    worker.postMessage({ type: 'start', assets })
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; id?: number; op?: string; args?: string; value?: string; error?: string }
      if (msg.type === 'failed') return finish(new Error(msg.error ?? 'Pyodide probe failed'))
      if (msg.type === 'done') {
        try { return finish(undefined, JSON.parse(msg.value ?? '') as ProbeResult) }
        catch { return finish(new Error('Invalid probe result')) }
      }
      if (msg.type !== 'request' || !Number.isSafeInteger(msg.id)) return
      void (async () => {
        try {
          if (active) throw new Error('Concurrent probe requests are not supported')
          active = true
          let result: unknown
          try { result = await dispatch(msg.op, msg.args) }
          finally { active = false }
          if (!finished) worker.postMessage({ type: 'response', id: msg.id, value: JSON.stringify({ ok: true, value: result }) })
        } catch (error) {
          const details = error instanceof WasmEngineError ? { outcome: error.outcome, actual: error.actual, code: error.code } : {}
          if (!finished) worker.postMessage({ type: 'response', id: msg.id, value: JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : String(error), ...details } }) })
        }
      })()
    }
  })
}
