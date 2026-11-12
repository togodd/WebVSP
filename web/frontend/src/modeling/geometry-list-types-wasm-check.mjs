// Run from web/frontend against a disposable, cross-origin-isolated Vite dev server:
// WEBVSP_TEST_CHROMIUM=/absolute/path/to/chromium node src/modeling/geometry-list-types-wasm-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/ (loopback HTTP(S) only).
// Optionally set WEBVSP_TEST_WASM_DIR to an absolute directory containing the matching
// vsp.js and vsp.wasm. Set WEBVSP_EXPECT_OLD_ENGINE=1 for an engine whose guarded
// geomTypes is not permitted. A fresh Chromium context owns only an in-memory model.
// Never use an existing browser/profile, picker, download, or user file.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const wasmDir = process.env.WEBVSP_TEST_WASM_DIR
if (wasmDir !== undefined && (!wasmDir || !isAbsolute(wasmDir))) throw new Error('WEBVSP_TEST_WASM_DIR must be an absolute path')
const wasmFiles = wasmDir ? new Map(await Promise.all(['vsp.js', 'vsp.wasm'].map(async name => [name, await readFile(join(wasmDir, name))]))) : null
const oldEngine = process.env.WEBVSP_EXPECT_OLD_ENGINE === '1'
const testPage = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
if (!['http:', 'https:'].includes(testPage.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testPage.hostname) || testPage.username || testPage.password) throw new Error('Test page must be a loopback HTTP(S) URL without credentials')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
const injected = new Set()
const timeout = setTimeout(() => { console.error('FAIL: geometry listTypes test timed out'); void browser.close() }, 180000)
try {
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== testPage.origin) return route.abort()
    const match = url.pathname.match(/(?:^|\/)wasm\/(vsp\.js|vsp\.wasm)$/)
    if (wasmFiles && match) {
      injected.add(match[1])
      return route.fulfill({ status: 200, body: wasmFiles.get(match[1]), headers: {
        'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin',
      } })
    }
    return route.continue()
  })
  await context.addInitScript(() => {
    window.__forbiddenFileActions = []
    const reject = action => { window.__forbiddenFileActions.push(action); throw new Error(`Forbidden file action: ${action}`) }
    Object.assign(window, {
      showOpenFilePicker: () => reject('open picker'),
      showSaveFilePicker: () => reject('save picker'),
      showDirectoryPicker: () => reject('directory picker'),
    })
    const click = HTMLElement.prototype.click
    HTMLElement.prototype.click = function () {
      if (this instanceof HTMLInputElement && this.type === 'file') return reject('file input')
      if (this instanceof HTMLAnchorElement && this.hasAttribute('download')) return reject('download')
      return click.call(this)
    }
    document.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('a[download], input[type="file"]')) {
        event.preventDefault()
        window.__forbiddenFileActions.push('file click')
      }
    }, true)
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('download', () => errors.push('Unexpected download'))
  page.on('filechooser', chooser => { errors.push('Unexpected file chooser'); void chooser.setFiles([]) })
  await page.goto(testPage.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation required')
    const api = window.__webvspModelingReadV1
    const engine = window.__webvspEngine
    if (typeof api?.geometry?.listTypes !== 'function') throw new Error('Production listTypes entry unavailable')
    if (typeof engine?.testCall !== 'function' || typeof engine?.testCallGuarded !== 'function') throw new Error('Vite dev test hooks unavailable')
    const capture = async fn => {
      try { return { value: await fn() } }
      catch (error) { return { error: { code: error?.code, message: error?.message, status: error?.status, outcome: error?.outcome } } }
    }
    const before = await api.model.getInfo()
    if (before.geometries.length !== 0) throw new Error('Refusing to replace a nonempty model')
    const legacy = await engine.testCall('geomTypes')
    const raw = await capture(() => engine.testCallGuarded('geomTypes', '', '', 0, before.identity.modelEpoch))
    const first = await capture(() => api.geometry.listTypes(before.identity))
    const invalid = await capture(() => api.geometry.listTypes({ ...before.identity, modelEpoch: '01' }))
    const missing = await capture(() => api.geometry.listTypes())
    const wrongSession = await capture(() => api.geometry.listTypes({ ...before.identity, sessionId: `${before.identity.sessionId}-other` }))
    // The direct handle is used only with its own identity; HMR may instantiate a
    // separate module from the already installed production entry.
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    let closed
    try {
      const ownIdentity = (await service.model.getInfo()).identity
      service.close()
      closed = await capture(() => service.geometry.listTypes(ownIdentity))
    } finally { service.close() }
    await engine.testCall('newModel')
    const after = await api.model.getInfo()
    const stale = await capture(() => api.geometry.listTypes(before.identity))
    const fresh = await capture(() => api.geometry.listTypes(after.identity))
    const legacyAfter = await engine.testCall('geomTypes')
    return { before: before.identity, after: after.identity, legacy, legacyAfter, raw, first, invalid, missing, wrongSession, closed, stale, fresh, forbidden: window.__forbiddenFileActions }
  })
  assert.ok(Array.isArray(result.legacy) && result.legacy.length > 0 && result.legacy.every(type => typeof type === 'string'), 'legacy types must be a nonempty string array')
  assert.deepEqual(result.legacyAfter, result.legacy, 'same engine legacy types after newModel')
  assert.notEqual(result.before.modelEpoch, result.after.modelEpoch, 'newModel changes the epoch')
  assert.equal(result.before.sessionId, result.after.sessionId)
  for (const name of ['invalid', 'missing']) assert.equal(result[name].error?.code, 'INVALID_ARGUMENT', name)
  assert.equal(result.wrongSession.error?.code, 'STALE_MODEL')
  assert.equal(result.closed.error?.code, 'SESSION_CLOSED')
  if (oldEngine) {
    assert.equal(result.raw.error?.message, 'Operation is not permitted by the guarded bridge', 'verify old engine lacks guarded geomTypes')
    assert.equal(result.raw.error?.outcome, 'not_written')
    for (const name of ['first', 'stale', 'fresh']) assert.equal(result[name].error?.code, 'ENGINE_ERROR', name)
  } else {
    assert.deepEqual(result.raw, { value: result.legacy }, 'guarded engine equals legacy')
    assert.deepEqual(result.first, { value: result.legacy }, 'production entry equals same-engine legacy')
    assert.equal(result.stale.error?.code, 'STALE_MODEL')
    assert.deepEqual(result.fresh, { value: result.legacyAfter }, 'fresh identity equals same-engine legacy')
  }
  assert.deepEqual(result.forbidden, [], 'no picker or download attempts')
  assert.deepEqual(errors, [])
  if (wasmFiles) assert.deepEqual([...injected].sort(), ['vsp.js', 'vsp.wasm'], 'both supplied WASM artifacts must load')
  console.log(`PASS: geometry.listTypes ${oldEngine ? 'rejects unsupported guarded operation on old engine' : 'matches legacy, rejects stale epoch and accepts fresh epoch'}; invalid identities and closed handle`)
} finally {
  clearTimeout(timeout)
  await context.close()
  await browser.close()
}
