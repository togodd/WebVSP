import { wasmRequest } from '../api/wasmEngine'

export interface ProbeResult {
  python: string
  beforeCount: number
  wingId: string
  afterCount: number
  error: string
}

/** Run a fixed diagnostic against this page's existing engine, never arbitrary Python. */
export function runDualWasmProbe(): Promise<ProbeResult> {
  const assets = new URL(`${import.meta.env.BASE_URL}pyodide/`, window.location.href).href
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let finished = false
    let dispatched = false
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
      const msg = event.data as { type?: string; id?: number; op?: string; value?: string; error?: string }
      if (msg.type === 'failed') return finish(new Error(msg.error ?? 'Pyodide probe failed'))
      if (msg.type === 'done') {
        try { return finish(undefined, JSON.parse(msg.value ?? '') as ProbeResult) }
        catch { return finish(new Error('Invalid probe result')) }
      }
      if (msg.type !== 'request' || !Number.isSafeInteger(msg.id)) return
      void (async () => {
        try {
          let value: string
          if (msg.op === 'model') value = JSON.stringify(await wasmRequest('GET', '/model'))
          else if (msg.op === 'create_wing') {
            dispatched = true
            const result = await wasmRequest('POST', '/geoms', { type: 'WING' }) as { id: string }
            // Use the normal selection path to refresh the mirrored Geom Browser after API creation.
            await wasmRequest('POST', '/pick', { id: result.id })
            value = result.id
          } else throw new Error('Unsupported probe operation')
          if (!finished) worker.postMessage({ type: 'response', id: msg.id, value })
        } catch (error) {
          if (!finished) worker.postMessage({ type: 'response', id: msg.id, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    }
  })
}
