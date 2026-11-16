/// <reference lib="webworker" />
// One disposable WASM instance per job. No page model or filesystem is passed in.
type P1Program = { callMain(args: string[]): number }
type ProgramFactory = (options: { noInitialRun: boolean; print: (s: string) => void; printErr: (s: string) => void }) => Promise<P1Program>
const scope = self as unknown as DedicatedWorkerGlobalScope
const PREFIX = 'WEBVSP_P1_RESULT='
const MAX_CHARS = 8 * 1024 * 1024
let started = false
scope.onmessage = ({ data }: MessageEvent<{ base: string; model: string; analysis: string }>) => {
  if (started) return // A disposable worker accepts at most one request.
  started = true
  void (async () => {
    if (!['WING', 'PROP'].includes(data.model) || !['DegenGeom', 'SurfacePatches'].includes(data.analysis)) throw new Error('Invalid isolated analysis request')
    const url = new URL('wasm/vsp_p1_analysis.js', data.base).href
    const { default: createProgram } = await import(/* @vite-ignore */ url) as { default: ProgramFactory }
    let snapshot: string | undefined
    let diagnostic = ''
    const program = await createProgram({ noInitialRun: true, print: (line) => {
      if (line.startsWith(PREFIX)) {
        if (snapshot !== undefined || line.length - PREFIX.length > MAX_CHARS) throw new Error('Invalid or oversized analysis output')
        snapshot = line.slice(PREFIX.length)
      } else if (diagnostic.length < 4096) diagnostic += line.slice(0, 4096 - diagnostic.length) + '\n'
    }, printErr: (line) => { if (diagnostic.length < 4096) diagnostic += line.slice(0, 4096 - diagnostic.length) + '\n' } })
    let status = 0
    try { status = program.callMain([data.model, data.analysis]) } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') status = error.status
      else throw error
    }
    if (status !== 0 || snapshot === undefined) throw new Error(`Isolated analysis failed (${status}): ${diagnostic.slice(0, 4096)}`)
    const parsed: unknown = JSON.parse(snapshot)
    if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).protocol !== 'webvsp-p1-analysis' || (parsed as Record<string, unknown>).version !== 1 || (parsed as Record<string, unknown>).model !== data.model || (parsed as Record<string, unknown>).analysis !== data.analysis) throw new Error('Invalid isolated analysis snapshot')
    scope.postMessage({ type: 'done', snapshot })
  })().catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
}
