import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { FileErrorNotice } from './FileErrorNotice'
import { PartialImportNotice } from './PartialImportNotice'
import { installBrowserReadApi } from './modeling/browserReadApi'

installBrowserReadApi()

// Explicitly opted-in diagnostic entry points for the browser tests in
// web/frontend/scripts. They are fixed scripts or user Python against the page
// model; there is no product UI here.
if (new URLSearchParams(window.location.search).get('dualWasmProbe') === '1') {
  void import('./dualWasmProbe/p1Probe').then(({ runP1AnalysisProbe, runP1CurrentModelProbe }) => {
    ;(window as unknown as Record<string, unknown>).__runP1AnalysisProbe = runP1AnalysisProbe
    ;(window as unknown as Record<string, unknown>).__runP1CurrentModelProbe = runP1CurrentModelProbe
  })
  void import('./dualWasmProbe/syncProbe').then(({ runSyncScript }) => {
    ;(window as unknown as Record<string, unknown>).__runPython = runSyncScript
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
