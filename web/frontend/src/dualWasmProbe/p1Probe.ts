// Explicit opt-in P1 diagnostic: fixed disposable models, never the page model.
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
let active = false

function runProgram(model: 'WING' | 'PROP', analysis: 'DegenGeom' | 'SurfacePatches', base: string): Promise<string> {
  const worker = new Worker(new URL('./p1ProgramWorker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, snapshot?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      if (error) reject(error)
      else resolve(snapshot!)
    }
    const timer = setTimeout(() => finish(new Error(`Isolated ${analysis} timed out; its disposable worker was terminated`)), 120_000)
    worker.onerror = (event) => finish(new Error(`Isolated analysis worker failed: ${event.message}`))
    worker.onmessageerror = () => finish(new Error('Invalid isolated analysis worker response'))
    worker.onmessage = ({ data }: MessageEvent<{ type?: string; snapshot?: string; error?: string } | null>) => {
      if (data?.type === 'failed') return finish(new Error(typeof data.error === 'string' ? data.error : 'Isolated analysis failed'))
      if (data?.type !== 'done' || typeof data.snapshot !== 'string' || data.snapshot.length > SNAPSHOT_MAX_BYTES || new TextEncoder().encode(data.snapshot).byteLength > SNAPSHOT_MAX_BYTES) return finish(new Error('Invalid or oversized isolated analysis snapshot'))
      finish(undefined, data.snapshot)
    }
    try { worker.postMessage({ model, analysis, base }) }
    catch (error) { finish(error instanceof Error ? error : new Error('Unable to start isolated analysis')) }
  })
}

/** Real analysis on disposable fixed geometry. This does not inspect the active GUI model. */
export async function runP1AnalysisProbe(): Promise<unknown> {
  if (active) throw new Error('An isolated P1 diagnostic is already running')
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Cross-origin isolation is required')
  active = true
  try {
    const base = new URL(import.meta.env.BASE_URL, window.location.href).href
    const reports: unknown[] = []
    for (const model of ['WING', 'PROP'] as const) {
      const degen = await runProgram(model, 'DegenGeom', base)
      const patches = await runProgram(model, 'SurfacePatches', base)
      const worker = new Worker(new URL('./p1PythonWorker.ts', import.meta.url), { type: 'module' })
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          let settled = false
          const finish = (error?: Error, value?: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (error) reject(error)
            else resolve(value)
          }
          const timer = setTimeout(() => finish(new Error('P1 Python diagnostic timed out')), 120_000)
          worker.onerror = (e) => finish(new Error(`P1 Python worker failed: ${e.message}`))
          worker.onmessageerror = () => finish(new Error('Invalid P1 Python worker response'))
          worker.onmessage = ({ data }: MessageEvent<{ type?: string; value?: string; error?: string } | null>) => {
            if (data?.type === 'failed') return finish(new Error(typeof data.error === 'string' ? data.error : 'P1 Python diagnostic failed'))
            if (data?.type !== 'done' || typeof data.value !== 'string' || data.value.length > SNAPSHOT_MAX_BYTES) return finish(new Error('Invalid P1 Python diagnostic result'))
            try { finish(undefined, JSON.parse(data.value)) } catch { finish(new Error('Invalid P1 Python diagnostic result')) }
          }
          try { worker.postMessage({ base, model, snapshots: { DegenGeom: degen, SurfacePatches: patches } }) }
          catch (error) { finish(error instanceof Error ? error : new Error('Unable to start P1 Python diagnostic')) }
        })
        reports.push(result)
      } finally { worker.terminate() }
    }
    return { isolation: 'disposable-fixed-model', pageModelUsed: false, reports }
  } finally { active = false }
}
