/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'
import liveFacade from './python/openvsp_live.py?raw'
import liveApiTable from './python/live_api_table.py?raw'
import enumTable from './python/enum_table.py?raw'
import exampleConstants from './python/Constants.py?raw'
import liveImports from './python/live_imports.py?raw'
import webvspFiles from './python/webvsp_files.py?raw'
// Bundled upstream files keep the src/python_api package layout so gaps stay visible.
import openvspUtilities from './python/packages/openvsp/openvsp/utilities.py?raw'
import openvspDegenParser from './python/packages/openvsp/openvsp/degen_geom_parse.py?raw'
import openvspPatches from './python/packages/openvsp/openvsp/surface_patches.py?raw'
import degenInit from './python/packages/degen_geom/degen_geom/__init__.py?raw'
import degenModule from './python/packages/degen_geom/degen_geom/degen_geom.py?raw'
import utilitiesInit from './python/packages/utilities/utilities/__init__.py?raw'
import utilitiesFiles from './python/packages/utilities/utilities/files.py?raw'
import utilitiesUnits from './python/packages/utilities/utilities/units.py?raw'
import utilitiesTransformations from './python/packages/utilities/utilities/transformations.py?raw'
import utilitiesUberlogging from './python/packages/utilities/utilities/uberlogging.py?raw'
import utilitiesWtUtil from './python/packages/utilities/utilities/wt_util.py?raw'
import utilitiesAtmosphere from './python/packages/utilities/utilities/atmosphere.py?raw'
import utilitiesRotor from './python/packages/utilities/utilities/simple_rotor_calcs.py?raw'

const scope = self as unknown as DedicatedWorkerGlobalScope
const MAX_BYTES = 64 * 1024
// Result reads can be large: one patch matrix or a full DegenGeom list.
const RESULTS_BYTES = 8 * 1024 * 1024
const RESPONSE_HEADER_BYTES = 8
let nextId = 0
// Async browser file requests (picker / save) handled by the page.
let nextFileId = 0
const pendingFiles = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function fileRequest(kind: 'file_open' | 'file_save', args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++nextFileId
    pendingFiles.set(id, { resolve, reject })
    scope.postMessage({ type: kind, id, ...args })
  })
}
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
  // A VSPAERO solver run blocks OpenVSP's thread for as long as the model needs;
  // the page stays responsive because it keeps draining the engine meanwhile.
  const budget = op === 'timeout_test' || op === 'timeout_real_test' ? 20 : op === 'live_analysis_run' ? 30 * 60_000 : 60_000
  const state = Atomics.wait(control, 0, 0, budget)
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
    // The facade takes the desktop package's import name; every other file is
    // written under the same relative path it has in src/python_api/packages.
    'openvsp/__init__.py': liveFacade,
    'live_api_table.py': liveApiTable,
    'enum_table.py': enumTable,
    // Example scripts do `import Constants`; keep it importable at top level.
    'Constants.py': exampleConstants,
    'openvsp/utilities.py': openvspUtilities,
    'openvsp/degen_geom_parse.py': openvspDegenParser,
    'openvsp/surface_patches.py': openvspPatches,
    'degen_geom/__init__.py': degenInit,
    'degen_geom/degen_geom.py': degenModule,
    'utilities/__init__.py': utilitiesInit,
    'utilities/files.py': utilitiesFiles,
    'utilities/units.py': utilitiesUnits,
    'utilities/transformations.py': utilitiesTransformations,
    'utilities/uberlogging.py': utilitiesUberlogging,
    'utilities/wt_util.py': utilitiesWtUtil,
    'utilities/atmosphere.py': utilitiesAtmosphere,
    'utilities/simple_rotor_calcs.py': utilitiesRotor,
  })) pyodide.FS.writeFile(`/sync-live/${name}`, content)
  pyodide.FS.writeFile('/sync-live/webvsp_files.py', webvspFiles)
  pyodide.registerJsModule('_webvsp_files_js', {
    open_into_engine: () => fileRequest('file_open', {}),
    save_from_engine: (path: string, name: string) => fileRequest('file_save', { path, name }),
  })
  pyodide.runPython("import sys\nif '/sync-live' not in sys.path: sys.path.insert(0, '/sync-live')")
  pyodide.runPython(liveImports)
}

// Optional scientific stack. The wheels are vendored and served same-origin but
// installed on demand: SciPy is ~14 MB, Matplotlib ~10 MB with its dependencies,
// pandas ~5 MB, and most sessions never touch them. The trigger is a static scan
// of the submitted code for the modules each package provides.
const OPTIONAL_PACKAGES = [
  { pkg: 'scipy', size: '14 MB', modules: ['scipy', 'utilities.atmosphere', 'utilities.simple_rotor_calcs'] },
  { pkg: 'matplotlib', size: '10 MB', modules: ['matplotlib', 'mpl_toolkits', 'openvsp.surface_patches', 'degen_geom.degen_geom', 'Constants'] },
  { pkg: 'pandas', size: '5 MB', modules: ['pandas'] },
]
const MODULE_SCAN_PRELUDE = `
import ast

def _webvsp_import_roots(source):
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name)
                roots.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            parts = node.module.split('.')
            roots.add(node.module)
            roots.add(parts[0] if len(parts) == 1 else parts[0] + '.' + parts[1])
            for alias in node.names:
                roots.add(node.module + '.' + alias.name)
    return roots

_webvsp_import_roots(code)
`

const optionalInstalls = new Map<string, Promise<void>>()

/** Install one vendored optional package once; console and script modes share it. */
function ensureOptional(pyodide: PyodideInterface, pkg: string): Promise<void> {
  let install = optionalInstalls.get(pkg)
  if (!install) {
    install = pyodide.loadPackage([pkg], { checkIntegrity: true }).then(() => undefined)
    optionalInstalls.set(pkg, install)
  }
  return install
}

async function importedRoots(pyodide: PyodideInterface, code: string): Promise<Set<string>> {
  const scope = pyodide.runPython('{}')
  try {
    scope.set('code', code)
    const roots = await pyodide.runPythonAsync(MODULE_SCAN_PRELUDE, { globals: scope })
    try { return new Set(roots.toJs() as string[]) } finally { roots.destroy?.() }
  } finally {
    scope.destroy()
  }
}

/** Install every optional package the submitted code imports. */
async function ensureImportedPackages(pyodide: PyodideInterface, code: string): Promise<void> {
  const roots = await importedRoots(pyodide, code)
  const wanted = OPTIONAL_PACKAGES.filter(entry => entry.modules.some(name => roots.has(name)))
  for (const entry of wanted) await ensureOptional(pyodide, entry.pkg)
}

/** Map an "No module named" message onto the optional package that provides it. */
function missingOptionalPackage(text: string): { pkg: string, size: string } | null {
  const match = /No module named '([^']+)'/.exec(text)
  if (!match) return null
  const moduleName = match[1]
  const root = moduleName.split('.')[0]
  const entry = OPTIONAL_PACKAGES.find(item => item.modules.some(name => name === moduleName || name.split('.')[0] === root))
  return entry ? { pkg: entry.pkg, size: entry.size } : null
}

async function runConsole(pyodide: PyodideInterface, message: ConsoleMessage): Promise<void> {
  const id = message.id ?? 0
  const out: string[] = []
  const started = performance.now()
  if (message.profile) resetBridgeStats()
  try {
    await ensureImportedPackages(pyodide, message.code ?? '')
    // Scripts commonly derive paths from __file__; give console code one under
    // the workspace and keep __name__ as __main__ so `if __name__ == ...` runs.
    pyodide.globals.set('__file__', '/work/console.py')
    pyodide.globals.set('__name__', '__main__')
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
    let text = error instanceof Error ? error.message : String(error)
    // A dynamic or indirect import bypassed the static scan. Install the package
    // and run the code once more, so the user does not have to retry by hand.
    const missing = missingOptionalPackage(text)
    if (missing) {
      try {
        await ensureOptional(pyodide, missing.pkg)
        const retry = await pyodide.runPythonAsync(message.code ?? '')
        let value = ''
        try { value = retry === undefined || retry === null ? '' : String(retry) } catch { value = '' }
        try { retry?.destroy?.() } catch { /* best effort */ }
        const profile: RunProfile | undefined = message.profile ? { ...getBridgeStats(), elapsedMs: performance.now() - started } : undefined
        scope.postMessage({ type: 'result', id, ok: true, value, stdout: out.join('\n'), profile })
        return
      } catch (retryError) {
        text = retryError instanceof Error ? retryError.message : String(retryError)
      }
      text += `\n(${missing.pkg} (${missing.size}) was installed for this run.)`
    }
    scope.postMessage({ type: 'result', id, ok: false, error: text, stdout: out.join('\n'), profile })
  }
}

type ConsoleMessage = { assets?: string; mode?: 'script' | 'console'; script?: string; type?: string; id?: number; code?: string; profile?: boolean; value?: unknown; error?: string }
let consoleReady: PyodideInterface | null = null

scope.onmessage = (event: MessageEvent<ConsoleMessage>) => {
  if (event.data.type === 'file_open_result' || event.data.type === 'file_save_result') {
    const pending = pendingFiles.get(event.data.id ?? -1)
    if (!pending) return
    pendingFiles.delete(event.data.id ?? -1)
    if (event.data.error) pending.reject(new Error(event.data.error))
    else pending.resolve(event.data.value)
    return
  }
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
      const script = event.data.script ?? ''
      // Script mode is the "paste a script" path, so it needs the same __file__
      // as the console: upstream examples derive paths from it.
      pyodide.globals.set('__file__', '/work/script.py')
      pyodide.globals.set('__name__', '__main__')
      await ensureImportedPackages(pyodide, script)
      const value = await pyodide.runPythonAsync(script)
      let text: string
      try { text = JSON.stringify(value) } catch { text = String(value) }
      scope.postMessage({ type: 'done', value: text })
      return
    }
    throw new Error('Unsupported Python worker mode')
  })().catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
}
