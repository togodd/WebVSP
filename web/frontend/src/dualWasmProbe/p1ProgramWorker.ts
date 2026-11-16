/// <reference lib="webworker" />
// One disposable WASM instance per job. No page model or filesystem is passed in,
// except the model text this job is explicitly asked to analyze.
type P1Program = {
  callMain(args: string[]): number
  FS: { writeFile(path: string, data: string): void }
}
type ProgramFactory = (options: { noInitialRun: boolean; print: (s: string) => void; printErr: (s: string) => void }) => Promise<P1Program>
const scope = self as unknown as DedicatedWorkerGlobalScope
const PREFIX = 'WEBVSP_P1_RESULT='
const MAX_CHARS = 8 * 1024 * 1024
const MAX_XML = 4 * 1024 * 1024
let started = false
scope.onmessage = ({ data }: MessageEvent<{ base: string; model?: string; analysis: string; xml?: string }>) => {
  if (started) return // A disposable worker accepts at most one request.
  started = true
  void (async () => {
    const fileMode = data.xml !== undefined
    const model = fileMode ? 'MODEL' : data.model
    if (!['WING', 'PROP', 'MODEL'].includes(model ?? '') || !['DegenGeom', 'SurfacePatches'].includes(data.analysis)) throw new Error('Invalid isolated analysis request')
    if (fileMode && (typeof data.xml !== 'string' || data.xml.length === 0 || data.xml.length > MAX_XML)) throw new Error('Invalid or oversized model input')
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
    if (fileMode) program.FS.writeFile('/p1-input.vsp3', data.xml!)
    let status = 0
    try { status = program.callMain([fileMode ? 'FILE' : data.model!, data.analysis]) } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') status = error.status
      else throw error
    }
    if (status !== 0 || snapshot === undefined) throw new Error(`Isolated analysis failed (${status}): ${diagnostic.slice(0, 4096)}`)
    const parsed: unknown = JSON.parse(snapshot)
    const header = parsed as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || header.protocol !== 'webvsp-p1-analysis' || header.version !== 1 || header.model !== model || header.analysis !== data.analysis) throw new Error('Invalid isolated analysis snapshot')
    scope.postMessage({ type: 'done', snapshot })
  })().catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
}
