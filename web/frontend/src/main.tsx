import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { FileErrorNotice } from './FileErrorNotice'
import { PartialImportNotice } from './PartialImportNotice'
import { installBrowserReadApi } from './modeling/browserReadApi'

installBrowserReadApi()

// Explicitly opted-in entry point for the browser tests in web/frontend/scripts:
// user Python against the live page model. There is no product UI here.
if (new URLSearchParams(window.location.search).get('dualWasmProbe') === '1') {
  void import('./dualWasmProbe/syncProbe').then(({ runSyncScript }) => {
    ;(window as unknown as Record<string, unknown>).__runPython = runSyncScript
  })
  // Test seam for the Python file-I/O prototype: bytes cross the page boundary as
  // base64 so Playwright can pass them in and read them back.
  const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary)
  }
  const base64ToBytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  void import('./api/pythonWorkspace').then(({ mountTestWorkspace, mountWorkspaceHandle }) => {
    ;(window as unknown as Record<string, unknown>).__webvspWorkspaceTest = {
      mount: (files: { name: string; base64: string }[]) =>
        mountTestWorkspace(files.map((f) => ({ name: f.name, bytes: base64ToBytes(f.base64) }))),
      // Drives the real directory-mount code with a fake handle (no picker).
      mountHandle: (files: { name: string; base64: string }[]) => {
        const handle = {
          name: 'fake-folder',
          kind: 'directory',
          async *entries() {
            for (const file of files) {
              yield [file.name, {
                name: file.name,
                kind: 'file',
                async getFile() { return new File([base64ToBytes(file.base64)], file.name) },
              }] as unknown as [string, FileSystemHandle]
            }
          },
        }
        return mountWorkspaceHandle(handle as unknown as FileSystemDirectoryHandle)
      },
    }
  })
  void import('./api/wasmEngine').then(({ putEngineFile, readEngineFile, setNextEngineFile, setCaptureEngineSave, takeSavedEngineFile }) => {
    ;(window as unknown as Record<string, unknown>).__webvspFileIO = {
      put: (name: string, base64: string) => putEngineFile(name, base64ToBytes(base64)),
      read: async (path: string) => bytesToBase64(await readEngineFile(path)),
      nextFile: (name: string, base64: string) => setNextEngineFile(name, base64ToBytes(base64)),
      captureSave: (on: boolean) => setCaptureEngineSave(on),
      takeSaved: () => {
        const saved = takeSavedEngineFile()
        return saved ? { name: saved.name, base64: bytesToBase64(saved.bytes) } : null
      },
    }
  })
}

/**
 * OpenVSP runs on its own thread in this tab, which needs a cross-origin isolated page. Where the server doesn't send the headers (e.g. GitHub Pages), a service worker adds
 * them (public/coi-sw.js); the page reloads once it is in control.
 */
async function isolate(): Promise<boolean> {
  if (window.crossOriginIsolated) return true
  if (!('serviceWorker' in navigator)) return false
  const KEY = 'webvsp-coi-reload'
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-sw.js`)
    await navigator.serviceWorker.ready
    if (!sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, '1')
      window.location.reload()
      return new Promise(() => {}) // reloading
    }
  } catch (err) {
    console.error('WebVSP: could not set up the page for OpenVSP', err)
  }
  sessionStorage.removeItem(KEY)
  return false
}

void isolate().then((ok) => {
  if (!ok) console.error('WebVSP: this page is not cross-origin isolated; OpenVSP cannot start')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      <FileErrorNotice />
      <PartialImportNotice />
    </StrictMode>,
  )
})
