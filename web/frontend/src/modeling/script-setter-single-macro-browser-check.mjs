// Disposable, isolated builds ONLY; never deploy these test artifacts. Run twice,
// with distinct build trees and servers: SCRIPT has WEBVSP_SCRIPT_GUARD_TEST
// and WEBVSP_PARM_REENTRY_TEST=OFF; PARM omits the SCRIPT define and has
// WEBVSP_PARM_REENTRY_TEST=ON. Serve the modeling test page with
// WEBVSP_TEST_WASM_ORIGIN pointing to the corresponding build's vsp.js/.wasm.
// From web/frontend: WEBVSP_TEST_MODE=SCRIPT WEBVSP_TEST_CHROMIUM=/path/to/chrome \
//   node src/modeling/script-setter-single-macro-browser-check.mjs
// For PARM also set WEBVSP_PARM_REENTRY_TEST_JS to parm_reentry_test.js from
// the SAME build tree serving vsp.js/.wasm. Node/SDK flags may be set via
// NODE_OPTIONS. This separate executable proves the hook works in that tree;
// it cannot independently prove which artifact the server actually serves.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const mode = process.env.WEBVSP_TEST_MODE
if (!['SCRIPT', 'PARM'].includes(mode)) throw new Error('Set WEBVSP_TEST_MODE to SCRIPT or PARM')
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const testPage = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
if (!['http:', 'https:'].includes(testPage.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testPage.hostname) || testPage.username || testPage.password) {
  throw new Error('Test page must be a loopback HTTP(S) URL without credentials')
}
if (mode === 'PARM') {
  const testJs = process.env.WEBVSP_PARM_REENTRY_TEST_JS
  if (!testJs) throw new Error('Set WEBVSP_PARM_REENTRY_TEST_JS to the same build tree’s parm_reentry_test.js')
  const test = spawnSync(process.execPath, [testJs], { encoding: 'utf8', timeout: 120000 })
  if (test.error) throw test.error
  assert.equal(test.status, 0, `parm_reentry_test failed: ${test.stderr}\n${test.stdout}`)
  assert.match(test.stdout, /parm reentry tests passed/)
  console.log('PASS: separately executed same-tree parm_reentry_test; server artifact provenance remains a prerequisite')
}

let browser
const deadline = setTimeout(() => { console.error('FAIL: single-macro browser check timed out'); process.exit(1) }, 180000)
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'] })
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      if (new URL(request.url()).origin !== testPage.origin || request.method() !== 'GET') return route.abort()
      const response = await route.fetch({ maxRedirects: 0 })
      if (response.status() >= 300 && response.status() < 400) return route.abort()
      return route.fulfill({ response })
    })
    await context.addInitScript(() => {
      window.__forbiddenFileActions = []
      const reject = action => { window.__forbiddenFileActions.push(action); throw new Error(`Forbidden file action: ${action}`) }
      Object.assign(window, { showOpenFilePicker: () => reject('open picker'), showSaveFilePicker: () => reject('save picker'), showDirectoryPicker: () => reject('directory picker') })
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
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
    page.on('crash', () => errors.push('page crashed'))
    page.on('download', () => errors.push('Unexpected download'))
    page.on('filechooser', () => errors.push('Unexpected file chooser'))
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
    const response = await page.goto(testPage.href, { timeout: 30000 })
    assert.ok(response?.ok(), 'modeling test page must load')
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    assert.equal(await page.evaluate(() => crossOriginIsolated), true)
    if (mode === 'SCRIPT') {
      const control = await page.evaluate(() => window.__webvspEngine.testCall('scriptGuardCheck'))
      assert.equal(control.unguardedRc, 0)
      assert.equal(control.afterUnguarded, control.before + 1)
      assert.notEqual(control.nestedRc, 0)
      assert.equal(control.innerAttempted, true)
      assert.equal(control.outerAttempted, true)
      assert.equal(control.afterNested, control.afterUnguarded)
      assert.equal(control.restoredRc, 0)
      assert.equal(control.afterCleanup, control.before)
      console.log('PASS: SCRIPT real-WASM guard control executed and cleaned up')
    }
    // A disposable nonempty sentinel detects unintended model or parm mutation.
    const result = await page.evaluate(async () => {
      const engine = window.__webvspEngine
      const call = (op, a = '') => engine.testCall(op, a)
      await engine.request('POST', '/file/new')
      const { id } = await call('addGeom', 'FUSELAGE')
      if (!id) throw new Error('Failed to create sentinel geometry')
      const length = await call('fuselageLength', id)
      if (!length?.id) throw new Error('Failed to read sentinel parameter')
      const snapshot = async () => ({ model: await call('model'), origin: await call('origin', id), length: await engine.testCall('geomParm', id, length.id) })
      const before = await snapshot()
      let error
      try { await call('scriptSetterGcProbe', 'disposable-empty-model'); error = null }
      catch (e) { error = { message: e.message, status: e.status } }
      return { id, before, error, after: await snapshot() }
    })
    assert.deepEqual(result.error, { message: 'unknown request: scriptSetterGcProbe', status: 400 })
    assert.equal(result.before.model.modelEpochValid, true)
    assert.ok(result.before.model.geoms.some(geom => geom.id === result.id))
    assert.deepEqual(result.after, result.before, 'rejected request must not alter sentinel model')
    assert.deepEqual(await page.evaluate(() => window.__forbiddenFileActions), [])
    assert.deepEqual(errors, [])
    console.log(`PASS: ${mode}-only build rejects scriptSetterGcProbe as unknown without model changes`)
  } finally { await context.close() }
} finally {
  try { if (browser) await browser.close() } finally { clearTimeout(deadline) }
}
