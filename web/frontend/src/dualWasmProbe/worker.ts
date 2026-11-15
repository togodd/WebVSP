/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'
import packageSource from './python/openvsp_wasm/__init__.py?raw'
import smokeSource from './python/smoke.py?raw'

const scope = self as unknown as DedicatedWorkerGlobalScope
const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>()
let nextId = 0

function request(op: string, args: string): Promise<string> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    scope.postMessage({ type: 'request', id, op, args })
  })
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as { type?: string; id?: number; value?: string; error?: string; assets?: string }
  if (message.type === 'start' && typeof message.assets === 'string') {
    void run(message.assets).catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
    return
  }
  if (message.type !== 'response' || typeof message.id !== 'number') return
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(message.error))
  else entry.resolve(message.value ?? '')
}

async function run(base: string) {
  // Resolve against the page-provided same-origin asset directory, including subpath deployments.
  const url = new URL('pyodide.mjs', base).href
  const { loadPyodide } = await import(/* @vite-ignore */ url) as { loadPyodide: (options: { indexURL: string }) => Promise<PyodideInterface> }
  const pyodide = await loadPyodide({ indexURL: base })
  pyodide.registerJsModule('webvsp_probe_bridge', { request })
  pyodide.FS.mkdirTree('/probe/openvsp_wasm')
  pyodide.FS.writeFile('/probe/openvsp_wasm/__init__.py', packageSource)
  pyodide.runPython("import sys; sys.path.insert(0, '/probe')")
  const result = await pyodide.runPythonAsync(smokeSource)
  scope.postMessage({ type: 'done', value: result })
}

