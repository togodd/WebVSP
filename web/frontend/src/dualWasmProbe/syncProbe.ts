import { callGuarded, syncProbeFileExperiment, wasmRequest } from '../api/wasmEngine'

type Geom = { id: string; name: string; type: string }
type Model = { geoms: Geom[]; modelEpoch: string; modelEpochValid: boolean }
const MAX_BYTES = 64 * 1024

/** Fixed opt-in experiment. It never creates or modifies a geometry. */
export async function runSyncProbe(): Promise<unknown> {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Cross-origin isolation and SharedArrayBuffer are required')
  const worker = new Worker(new URL('./syncWorker.ts', import.meta.url), { type: 'module' })
  const assets = new URL(`${import.meta.env.BASE_URL}pyodide/`, window.location.href).href
  return new Promise((resolve, reject) => {
    let finished = false
    let active = false
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
    const timer = setTimeout(() => finish(new Error('Synchronous probe timed out; an already dispatched file operation may have completed')), 120_000)
    async function model(): Promise<Model> {
      const result = await wasmRequest('GET', '/model') as Model
      if (!result.modelEpochValid || !result.modelEpoch) throw new Error('Model identity unavailable')
      if (epoch !== undefined && epoch !== result.modelEpoch) throw new Error('Model was replaced during probe')
      epoch = result.modelEpoch
      return result
    }
    async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
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
      if (op === 'find_geom') {
        if (typeof args.name !== 'string' || args.index !== 0) throw new Error('Only FindGeom(name, 0) is supported')
        return (await model()).geoms.find((g) => g.name === args.name)?.id ?? ''
      }
      if (op === 'parm_value') {
        if (typeof args.geom !== 'string' || !args.geom || args.group !== 'WingGeom' || typeof args.name !== 'string' || !['TotalArea', 'TotalSpan', 'TotalChord'].includes(args.name)) throw new Error('Unsupported parameter query')
        const current = await model()
        if (!current.geoms.some((g) => g.id === args.geom && g.type === 'Wing')) throw new Error('Wing not found in current model')
        let matches = parameterIds.get(args.geom)
        if (!matches) {
          const ids = await callGuarded<string[]>('geomParmIDs', args.geom, '', 0, epoch!)
          if (new Set(ids).size !== ids.length) throw new Error('Duplicate parameter ID')
          matches = new Map<string, string>()
          for (const id of ids) {
            if (finished) throw new Error('Probe stopped')
            const p: { name: string; group: string; container: string } = await callGuarded('geomParm', args.geom, id, 0, epoch!)
            if (p.group === 'WingGeom' && p.container === args.geom && ['TotalArea', 'TotalSpan', 'TotalChord'].includes(p.name)) {
              if (matches.has(p.name)) throw new Error('Ambiguous parameter')
              matches.set(p.name, id)
            }
          }
          if (matches.size !== 3) throw new Error('Reference parameter not found')
          parameterIds.set(args.geom, matches)
        }
        const parmId = matches.get(args.name)
        if (!parmId) throw new Error('Parameter not found')
        const p: { name: string; group: string; container: string; value: number | null } = await callGuarded('geomParm', args.geom, parmId, 0, epoch!)
        if (p.name !== args.name || p.group !== args.group || p.container !== args.geom || typeof p.value !== 'number' || !Number.isFinite(p.value)) throw new Error('Parameter changed or is invalid')
        return p.value
      }
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
      if (msg.type !== 'request' || !(msg.buffer instanceof SharedArrayBuffer) || msg.buffer.byteLength !== 8 + MAX_BYTES) return finish(new Error('Invalid sync request'))
      const buffer = msg.buffer
      if (msg.op === 'timeout_test') {
        setTimeout(() => {
          const bytes = new TextEncoder().encode('{"ok":true,"value":"late"}')
          new Uint8Array(buffer, 8).set(bytes)
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
          if (active) throw new Error('A previous request is still in flight; do not retry dispatched operations')
          active = true
          try {
            const args = JSON.parse(msg.args ?? '{}') as Record<string, unknown>
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments')
            response = { ok: true, value: await dispatch(msg.op ?? '', args) }
          } finally { active = false }
        } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) } }
        if (finished) return
        let bytes = new TextEncoder().encode(JSON.stringify(response))
        if (bytes.length > MAX_BYTES) bytes = new TextEncoder().encode(JSON.stringify({ ok: false, error: 'Response exceeds buffer limit' }))
        new Uint8Array(buffer, 8).set(bytes)
        const control = new Int32Array(buffer, 0, 2)
        Atomics.store(control, 1, bytes.length)
        Atomics.store(control, 0, 1)
        Atomics.notify(control, 0)
      })()
    }
    worker.postMessage({ assets })
  })
}
