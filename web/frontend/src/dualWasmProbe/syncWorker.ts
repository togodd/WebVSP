/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'
import nativeUtility from './python/sync_native_utility.py?raw'
import smoke from './python/sync_smoke.py?raw'
import modelingSmoke from './python/sync_modeling_smoke.py?raw'
import facade from './python/openvsp.py?raw'
import syncGenerated from './python/_sync_generated.py?raw'
import nativeOpenVspUtilities from './python/native/openvsp_utilities.py?raw'
import nativeUtilitiesInit from './python/native/utilities/__init__.py?raw'
import nativeUtilitiesFiles from './python/native/utilities/files.py?raw'
import nativeUtilitiesUnits from './python/native/utilities/units.py?raw'
import nativeUtilitiesTransformations from './python/native/utilities/transformations.py?raw'

const scope = self as unknown as DedicatedWorkerGlobalScope
const MAX_BYTES = 64 * 1024
let nextId = 0

function request(op: string, args: string): string {
  const buffer = new SharedArrayBuffer(8 + MAX_BYTES)
  const control = new Int32Array(buffer, 0, 2)
  scope.postMessage({ type: 'request', id: ++nextId, op, args, buffer })
  const state = Atomics.wait(control, 0, 0, op === 'timeout_test' || op === 'timeout_real_test' ? 20 : 60_000)
  if (state === 'timed-out' && Atomics.load(control, 0) === 0) {
    if (op !== 'timeout_test') scope.postMessage({ type: 'abandon' })
    throw new Error('Synchronous probe request timed out; do not retry a dispatched write')
  }
  if (Atomics.load(control, 0) !== 1) throw new Error('Invalid synchronous probe response')
  const size = Atomics.load(control, 1)
  if (size < 0 || size > MAX_BYTES) throw new Error('Invalid response size')
  // TextDecoder rejects shared-backed views in Chromium; copy into an ordinary buffer.
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(new Uint8Array(buffer, 8, size)))
}

scope.onmessage = (event: MessageEvent<{ assets: string; mode: 'read' | 'modeling' }>) => {
  void (async () => {
    const base = event.data.assets
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
    pyodide.runPython("import sys; sys.path.insert(0, '/sync-probe')")
    const result = pyodide.runPython(event.data.mode === 'modeling' ? modelingSmoke : smoke) as string
    scope.postMessage({ type: 'done', value: result })
  })().catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
}
