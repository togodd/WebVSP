// Explicit opt-in P1 diagnostics. Contexts: fixed disposable models, or one
// disposable copy of the current model. Never run an analysis in the page engine.
import { callGuarded, discoverModel } from '../api/wasmEngine'

const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
let active = false

interface XmlProbe {
  ok: boolean
  error?: string
  xml?: string
  xmlBytes: number
  fingerprintHash: string
  fingerprintLines: number
  types: string[]
  unsupported?: { name: string; type: string; attached: boolean }[]
}

function runProgram(request: { model?: string; analysis: 'DegenGeom' | 'SurfacePatches'; xml?: string }, base: string): Promise<string> {
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
    const label = request.xml !== undefined ? request.analysis : `${request.model} ${request.analysis}`
    const timer = setTimeout(() => finish(new Error(`Isolated ${label} timed out; its disposable worker was terminated`)), 120_000)
    worker.onerror = (event) => finish(new Error(`Isolated analysis worker failed: ${event.message}`))
    worker.onmessageerror = () => finish(new Error('Invalid isolated analysis worker response'))
    worker.onmessage = ({ data }: MessageEvent<{ type?: string; snapshot?: string; error?: string } | null>) => {
      if (data?.type === 'failed') return finish(new Error(typeof data.error === 'string' ? data.error : 'Isolated analysis failed'))
      if (data?.type !== 'done' || typeof data.snapshot !== 'string' || data.snapshot.length > SNAPSHOT_MAX_BYTES || new TextEncoder().encode(data.snapshot).byteLength > SNAPSHOT_MAX_BYTES) return finish(new Error('Invalid or oversized isolated analysis snapshot'))
      finish(undefined, data.snapshot)
    }
    try { worker.postMessage({ ...request, base }) }
    catch (error) { finish(error instanceof Error ? error : new Error('Unable to start isolated analysis')) }
  })
}

function pythonWorker(base: string, model: string, snapshots: Record<string, string>): Promise<unknown> {
  const worker = new Worker(new URL('./p1PythonWorker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
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
    try { worker.postMessage({ base, model, snapshots }) }
    catch (error) { finish(error instanceof Error ? error : new Error('Unable to start P1 Python diagnostic')) }
  })
}

function analyzeSnapshots(
  base: string,
  model: string,
  snapshots: { DegenGeom: string; SurfacePatches: string },
  expectedFingerprint?: string,
): Promise<unknown> {
  if (expectedFingerprint !== undefined) {
    for (const [analysis, raw] of Object.entries(snapshots)) {
      let parsed: { modelFingerprint?: string }
      try { parsed = JSON.parse(raw) } catch { throw new Error(`Invalid ${analysis} snapshot`) }
      if (parsed.modelFingerprint !== expectedFingerprint) throw new Error(`Isolated copy of the current model does not match (${analysis})`)
    }
  }
  return pythonWorker(base, model, snapshots)
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
      const degen = await runProgram({ model, analysis: 'DegenGeom' }, base)
      const patches = await runProgram({ model, analysis: 'SurfacePatches' }, base)
      reports.push(await analyzeSnapshots(base, model, { DegenGeom: degen, SurfacePatches: patches }))
    }
    return { isolation: 'disposable-fixed-model', pageModelUsed: false, reports }
  } finally { active = false }
}

/**
 * Analyze a serialized copy of the current model in the isolated instance.
 * Fails closed when the model is unsupported, cannot be serialized, or the copy's
 * fingerprint differs from the source. The page model is never mutated by analysis.
 */
export async function runP1CurrentModelProbe(): Promise<unknown> {
  if (active) throw new Error('An isolated P1 diagnostic is already running')
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Cross-origin isolation is required')
  active = true
  try {
    const base = new URL(import.meta.env.BASE_URL, window.location.href).href
    const model = await discoverModel<{ modelEpoch?: string; geoms?: unknown[] }>(new AbortController().signal)
    if (!model.modelEpoch) throw new Error('The current model identity is unavailable')
    if (!model.geoms?.length) throw new Error('The current model has no geometry to analyze')
    const probe = await callGuarded<XmlProbe>('p1XmlProbe', 'xml', '', 1, model.modelEpoch)
    if (!probe.ok) {
      if (probe.error === 'EMPTY_MODEL') throw new Error('The current model has no geometry to analyze')
      const detail = (probe.unsupported ?? []).map(u => `${u.name} (${u.type}${u.attached ? ', attached' : ''})`).join(', ')
      throw new Error(`Model is outside the supported subset: ${detail || probe.error}`)
    }
    if (!probe.xml) throw new Error('Model serialization returned no data')
    const degen = await runProgram({ analysis: 'DegenGeom', xml: probe.xml }, base)
    const patches = await runProgram({ analysis: 'SurfacePatches', xml: probe.xml }, base)
    const report = await analyzeSnapshots(base, 'MODEL', { DegenGeom: degen, SurfacePatches: patches }, probe.fingerprintHash)
    return {
      isolation: 'disposable-model-snapshot',
      pageModelUsed: true,
      modelFingerprint: probe.fingerprintHash,
      xmlBytes: probe.xmlBytes,
      sourceTypes: probe.types,
      reports: [report],
    }
  } finally { active = false }
}
