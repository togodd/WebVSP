// ONLY a disposable WASM built with BOTH WEBVSP_SCRIPT_GUARD_TEST and
// WEBVSP_PARM_REENTRY_TEST. Never deploy it or use a real user model/profile.
// Serve the modeling test page with WEBVSP_TEST_WASM_ORIGIN pointing to that
// isolated build; set WEBVSP_TEST_CHROMIUM and optionally WEBVSP_TEST_PAGE.
// The new browser context creates a fresh engine worker. Discard it after the probe.
// For a THREE-macro WEBVSP_DELETE_GEOM_PROXY_TEST build set WEBVSP_DELETE_PROXY_CASE
// to 'control' or 'setter'; run each in a separate invocation/fresh worker. Without
// that variable the original two-macro observation remains unchanged.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const proxyCase = process.env.WEBVSP_DELETE_PROXY_CASE ?? ''
if (!['', 'control', 'setter'].includes(proxyCase)) throw new Error('WEBVSP_DELETE_PROXY_CASE must be control or setter')
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const testPage = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
if (!['http:', 'https:'].includes(testPage.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testPage.hostname) || testPage.username || testPage.password) {
  throw new Error('Test page must be a loopback HTTP(S) URL without credentials')
}
let browser
const deadline = setTimeout(async () => {
  console.error('FAIL: setter GC probe timed out')
  const hardExit = setTimeout(() => process.exit(1), 5000)
  hardExit.unref()
  try { await browser?.close() } catch { /* hard exit remains armed */ }
  process.exit(1)
}, 180000)
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
    page.on('worker', worker => {
      console.log(`worker started: ${worker.url()}`)
      worker.on('close', () => console.log(`worker closed: ${worker.url()}`))
    })
    const response = await page.goto(testPage.href, { timeout: 30000 })
    assert.ok(response?.ok())
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    assert.equal(await page.evaluate(() => crossOriginIsolated), true)
    const request = proxyCase === 'control' ? 'disposable-delete-control' : 'disposable-empty-model'
    const result = await page.evaluate(request => window.__webvspEngine.testCall('scriptSetterGcProbe', request), request)
    console.log(JSON.stringify(result))
    assert.equal(result.buildMode, proxyCase ? 'delete-geom-proxy' : 'original', 'probe build must match the selected case')
    if (proxyCase === 'control') {
      assert.equal(result.executeRc, 0)
      assert.equal(result.positiveAliveAfter, false, 'unguarded script DeleteGeom must forward')
      assert.equal(result.explicitErrors, '')
      assert.equal(result.defaultErrors, 'DeleteGeom::PodGeom_Clone has lost the Geom it was copying, and has been cleared.  Choose an original for it again.')
      assert.equal(result.explicitCloneRc, 0)
      assert.equal(result.explicitOriginalAfter, false)
      assert.equal(result.explicitCloneAfter, false, 'explicit CLONE_DELETE_WITH_ORIGINAL must reach DeleteGeom')
      assert.equal(result.defaultCloneRc, 0)
      assert.equal(result.defaultOriginalAfter, false)
      assert.equal(result.defaultCloneAfter, true, 'default CLONE_DELETE_LEAVE_EMPTY must retain the clone')
      assert.equal(result.victimAliveBefore, true)
      assert.equal(result.victimAliveAfter, true, 'guarded script DeleteGeom must be blocked')
      assert.equal(result.destroyedBefore, 0)
      assert.equal(result.destroyedAfter, 1)
      assert.equal(result.gcRc, 0)
      assert.equal(result.outerBefore, false)
      assert.equal(result.innerBefore, false)
      assert.equal(result.outerAfter, true)
      assert.equal(result.innerAfter, true)
      assert.equal(result.outerFixtureRc, 0)
      assert.equal(result.outerDestroyedBefore, 1)
      assert.equal(result.outerDestroyedAfter, 2, 'outer-only destructor must run')
      assert.equal(result.outerVictimBefore, true)
      assert.equal(result.outerVictimAfter, true, 'remaining outer guard must block deletion')
      assert.equal(result.innerPoppedBefore, false)
      assert.equal(result.outerOnlyBefore, false)
      assert.equal(result.outerOnlyAfter, true, 'remaining outer guard must record the attempt')
      assert.equal(result.outerGcRc, 0)
      assert.equal(result.nonLifoFixtureRc, 0)
      assert.equal(result.nonLifoDestroyedBefore, 2)
      assert.equal(result.nonLifoDestroyedAfter, 3, 'non-LIFO destructor must run')
      assert.equal(result.nonLifoVictimBefore, true)
      assert.equal(result.nonLifoVictimAfter, true, 'remaining inner guard must block deletion')
      assert.equal(result.nonLifoOuterBefore, false)
      assert.equal(result.nonLifoInnerBefore, false)
      assert.equal(result.nonLifoInnerAfter, true, 'inner guard must record after outer destruction')
      assert.equal(result.nonLifoGcRc, 0)
      assert.equal(result.restoredBefore, true)
      assert.equal(result.restoredRc, 0)
      assert.equal(result.restoredAfter, false, 'deletion must forward after all guards exit')
      assert.equal(result.errors, '')
    } else {
    assert.equal(result.executeRc, 0)
    assert.equal(result.setterHits, 1, 'the real target setter must be reached exactly once')
    assert.equal(result.gcRc, 0)
    assert.equal(result.destroyedBefore, 0)
    assert.equal(result.destroyedAfter, 1, 'the cycle destructor must actually run')
    assert.equal(result.guardPresent, true)
    assert.equal(result.attemptedBefore, false)
    assert.equal(typeof result.attemptedAfter, 'boolean')
    assert.equal(result.victimAliveBefore, true)
    assert.equal(typeof result.victimAliveAfter, 'boolean')
    assert.equal(result.targetAliveAfter, true, 'victim and active setter target are independent')
    assert.ok(result.reply, 'guarded write must return a reply')
    if (result.attemptedAfter) {
      assert.equal(result.reply.ok, false)
      assert.equal(result.reply.code, 'SCRIPT_REENTRY_BLOCKED')
      assert.equal(result.reply.outcome, 'unknown')
    } else {
      // A destructor may mutate the independent victim without setting the guard;
      // report that observation, while checking the resulting write reply honestly.
      assert.equal(result.reply.ok, true)
      assert.equal(result.reply.value.actual, 12)
    }
    assert.equal(result.errors, '')
    if (proxyCase === 'setter') {
      assert.equal(result.attemptedAfter, true)
      assert.equal(result.victimAliveAfter, true)
    }
    }
    const retryError = await page.evaluate(async () => {
      try { await window.__webvspEngine.testCall('scriptSetterGcProbe', 'disposable-empty-model'); return null }
      catch (error) { return error.message }
    })
    assert.match(retryError ?? '', /fresh disposable empty test module/)
    assert.deepEqual(await page.evaluate(() => window.__forbiddenFileActions), [])
    assert.deepEqual(errors, [])
    console.log('PASS: fixed setter GC observation (victim and guard outcomes reported, not assumed)')
  } finally { await context.close() }
} finally {
  try { if (browser) await browser.close() } finally { clearTimeout(deadline) }
}
