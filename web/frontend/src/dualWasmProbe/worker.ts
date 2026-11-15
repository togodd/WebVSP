/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'

const scope = self as unknown as DedicatedWorkerGlobalScope
const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>()
let nextId = 0

function request(op: string): Promise<string> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    scope.postMessage({ type: 'request', id, op })
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
  const result = await pyodide.runPythonAsync(`
import json
import sys
from webvsp_probe_bridge import request

# Fixed proof-of-concept only: no caller-provided code or arbitrary API access.
before = json.loads(await request('model'))
wing_id = await request('create_wing')
after = json.loads(await request('model'))
assert any(g['id'] == wing_id and g['type'] == 'Wing' for g in after['geoms'])
try:
    await request('unsupported')
except Exception as exc:
    error = str(exc)
else:
    raise AssertionError('Unsupported operation did not fail')
json.dumps({'python': sys.version.split()[0], 'beforeCount': len(before['geoms']), 'wingId': wing_id, 'afterCount': len(after['geoms']), 'error': error})
`)
  scope.postMessage({ type: 'done', value: result })
}

