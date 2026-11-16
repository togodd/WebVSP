/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'
import nativeUtility from './python/sync_native_utility.py?raw'
import smoke from './python/sync_smoke.py?raw'
import modelingSmoke from './python/sync_modeling_smoke.py?raw'
import facade from './python/openvsp.py?raw'
import liveFacade from './python/openvsp_live.py?raw'
import nativeDegenParser from './python/native/degen_geom_parse.py?raw'
import nativePatches from './python/native/surface_patches.py?raw'
import degenInit from './python/native/degen_geom/__init__.py?raw'
import degenModule from './python/native/degen_geom/degen_geom.py?raw'
import syncGenerated from './python/_sync_generated.py?raw'
import nativeOpenVspUtilities from './python/native/openvsp_utilities.py?raw'
import nativeUtilitiesInit from './python/native/utilities/__init__.py?raw'
import nativeUtilitiesFiles from './python/native/utilities/files.py?raw'
import nativeUtilitiesUnits from './python/native/utilities/units.py?raw'
import nativeUtilitiesTransformations from './python/native/utilities/transformations.py?raw'

const scope = self as unknown as DedicatedWorkerGlobalScope
const MAX_BYTES = 64 * 1024
// Result reads can be large: one patch matrix or a full DegenGeom list.
const RESULTS_BYTES = 8 * 1024 * 1024
const RESPONSE_HEADER_BYTES = 8
let nextId = 0
// Only completed requests return their buffer to the pool. A timed-out request
// permanently loses ownership, so a delayed page response cannot corrupt a
// later request even though the buffer itself remains alive in the page.
const responseBuffers = new Map<number, SharedArrayBuffer>()

type BridgeStats = {
  calls: number
  waitMs: number
  responseBytes: number
  byOp: Record<string, { calls: number; waitMs: number; bytes: number }>
}

type RunProfile = BridgeStats & { elapsedMs: number }

const bridgeStats: BridgeStats = { calls: 0, waitMs: 0, responseBytes: 0, byOp: {} }

function resetBridgeStats(): void {
  bridgeStats.calls = 0
  bridgeStats.waitMs = 0
  bridgeStats.responseBytes = 0
  bridgeStats.byOp = {}
}

function getBridgeStats(reset = false): BridgeStats {
  const snapshot: BridgeStats = {
    calls: bridgeStats.calls,
    waitMs: bridgeStats.waitMs,
    responseBytes: bridgeStats.responseBytes,
    byOp: Object.fromEntries(Object.entries(bridgeStats.byOp).map(([op, stat]) => [op, { ...stat }])),
  }
  if (reset) resetBridgeStats()
  return snapshot
}

function request(op: string, args: string): string | Uint8Array {
  const capacity = op.startsWith('live_result') || op.startsWith('results_') ? RESULTS_BYTES : MAX_BYTES
  const buffer = responseBuffers.get(capacity) ?? new SharedArrayBuffer(RESPONSE_HEADER_BYTES + capacity)
  responseBuffers.delete(capacity) // This request owns it until a valid response arrives.
  const control = new Int32Array(buffer, 0, 2)
  Atomics.store(control, 0, 0)
  Atomics.store(control, 1, 0)
  scope.postMessage({ type: 'request', id: ++nextId, op, args, buffer, capacity })
  const started = performance.now()
  const state = Atomics.wait(control, 0, 0, op === 'timeout_test' || op === 'timeout_real_test' ? 20 : 60_000)
  const waitMs = performance.now() - started
  bridgeStats.calls += 1
  bridgeStats.waitMs += waitMs
  const stat = bridgeStats.byOp[op] ?? (bridgeStats.byOp[op] = { calls: 0, waitMs: 0, bytes: 0 })
  stat.calls += 1
  stat.waitMs += waitMs
  if (state === 'timed-out' && Atomics.load(control, 0) === 0) {
    if (op !== 'timeout_test') scope.postMessage({ type: 'abandon' })
    throw new Error('Synchronous probe request timed out; do not retry a dispatched write')
  }
  if (Atomics.load(control, 0) !== 1) throw new Error('Invalid synchronous probe response')
  const signedSize = Atomics.load(control, 1)
  const size = Math.abs(signedSize)
  if (size > capacity) throw new Error('Invalid response size')
  bridgeStats.responseBytes += size
  stat.bytes += size
  const copy = Uint8Array.from(new Uint8Array(buffer, RESPONSE_HEADER_BYTES, size))
  responseBuffers.set(capacity, buffer)
  if (signedSize < 0) return copy
  // TextDecoder rejects shared-backed views in Chromium; copy into an ordinary buffer.
  return new TextDecoder('utf-8', { fatal: true }).decode(copy)
}

async function setupLive(pyodide: PyodideInterface): Promise<void> {
  await pyodide.loadPackage(['numpy', 'six'], { checkIntegrity: true })
  for (const dir of ['/sync-live/openvsp', '/sync-live/utilities', '/sync-live/degen_geom']) pyodide.FS.mkdirTree(dir)
  for (const [name, content] of Object.entries({
    'openvsp/__init__.py': liveFacade,
    'degen_geom_parse.py': nativeDegenParser,
    'surface_patches.py': nativePatches,
    'degen_geom/__init__.py': degenInit,
    'degen_geom/degen_geom.py': degenModule,
    'openvsp_utilities.py': nativeOpenVspUtilities,
    'utilities/__init__.py': nativeUtilitiesInit,
    'utilities/files.py': nativeUtilitiesFiles,
    'utilities/units.py': nativeUtilitiesUnits,
    'utilities/transformations.py': nativeUtilitiesTransformations,
  })) pyodide.FS.writeFile(`/sync-live/${name}`, content)
  pyodide.runPython("import sys\nif '/sync-live' not in sys.path: sys.path.insert(0, '/sync-live')")
  // Keep the bundled helper byte-identical to OpenVSP; select the fast facade
  // implementation when this live runtime imports it.
  pyodide.runPython("import surface_patches, openvsp\nsurface_patches.export_surface_patches = openvsp.parse_surface_patches_fast")
}

async function runConsole(pyodide: PyodideInterface, message: ConsoleMessage): Promise<void> {
  const id = message.id ?? 0
  const out: string[] = []
  const started = performance.now()
  if (message.profile) resetBridgeStats()
  try {
    pyodide.setStdout({ batched: (text) => out.push(text) })
    pyodide.setStderr({ batched: (text) => out.push(text) })
    const value = await pyodide.runPythonAsync(message.code ?? '')
    let text: string
    try { text = value === undefined || value === null ? '' : String(value) } catch { text = '' }
    try { value?.destroy?.() } catch { /* best effort */ }
    const profile: RunProfile | undefined = message.profile ? { ...getBridgeStats(), elapsedMs: performance.now() - started } : undefined
    scope.postMessage({ type: 'result', id, ok: true, value: text, stdout: out.join('\n'), profile })
  } catch (error) {
    const profile: RunProfile | undefined = message.profile ? { ...getBridgeStats(), elapsedMs: performance.now() - started } : undefined
    scope.postMessage({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error), stdout: out.join('\n'), profile })
  }
}

type ConsoleMessage = { assets?: string; mode?: 'read' | 'modeling' | 'script' | 'console'; script?: string; type?: string; id?: number; code?: string; profile?: boolean }
let consoleReady: PyodideInterface | null = null

scope.onmessage = (event: MessageEvent<ConsoleMessage>) => {
  if (event.data.type === 'run' && consoleReady) {
    void runConsole(consoleReady, event.data)
    return
  }
  void (async () => {
    const base = event.data.assets
    if (!base) throw new Error('Missing Pyodide asset base')
    const url = new URL('pyodide.mjs', base).href
    const { loadPyodide } = await import(/* @vite-ignore */ url) as { loadPyodide: (options: { indexURL: string }) => Promise<PyodideInterface> }
    const pyodide = await loadPyodide({ indexURL: base })
    pyodide.registerJsModule('sync_bridge', { request })
    pyodide.FS.mkdirTree('/sync-probe')
    pyodide.FS.writeFile('/sync-probe/sync_native_utility.py', nativeUtility)
    pyodide.FS.writeFile('/sync-probe/openvsp.py', facade)
    pyodide.FS.writeFile('/sync-probe/_sync_generated.py', syncGenerated)
    if (event.data.mode === 'read') {
      await pyodide.loadPackage(['numpy', 'six'], { checkIntegrity: true })
      pyodide.FS.mkdirTree('/sync-probe/utilities')
      pyodide.FS.writeFile('/sync-probe/native_openvsp_utilities.py', nativeOpenVspUtilities)
      pyodide.FS.writeFile('/sync-probe/utilities/__init__.py', nativeUtilitiesInit)
      pyodide.FS.writeFile('/sync-probe/utilities/files.py', nativeUtilitiesFiles)
      pyodide.FS.writeFile('/sync-probe/utilities/units.py', nativeUtilitiesUnits)
      pyodide.FS.writeFile('/sync-probe/utilities/transformations.py', nativeUtilitiesTransformations)
    }
    if (event.data.mode === 'console') {
      await setupLive(pyodide)
      const lines: string[] = []
      pyodide.setStdout({ batched: (text) => { if (lines.length < 2000) lines.push(text) } })
      pyodide.setStderr({ batched: (text) => { if (lines.length < 2000) lines.push(text) } })
      consoleReady = pyodide
      scope.postMessage({ type: 'ready' })
      return
    }
    if (event.data.mode === 'script') {
      await setupLive(pyodide)
      const value = await pyodide.runPythonAsync(event.data.script ?? '')
      let text: string
      try { text = JSON.stringify(value) } catch { text = String(value) }
      scope.postMessage({ type: 'done', value: text })
      return
    }
    pyodide.runPython("import sys; sys.path.insert(0, '/sync-probe')")
    const result = pyodide.runPython(event.data.mode === 'modeling' ? modelingSmoke : smoke) as string
    scope.postMessage({ type: 'done', value: result })
  })().catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
}
