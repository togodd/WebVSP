// Run from web/frontend against an already running, cross-origin-isolated server:
// WEBVSP_TEST_CHROMIUM=/absolute/path/to/chromium node src/modeling/session-reload-wasm-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/. No existing browser/profile or user files.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const testPage = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
if (!['http:', 'https:'].includes(testPage.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testPage.hostname) || testPage.username || testPage.password) {
  throw new Error('Test page must be a loopback HTTP(S) URL without credentials')
}
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'] })
const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
const timeout = setTimeout(() => { console.error('FAIL: session reload test timed out'); void browser.close() }, 180000)
try {
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === testPage.origin ? route.continue() : route.abort()
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
  page.on('filechooser', () => errors.push('Unexpected file chooser'))
  const ready = async () => {
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'cross-origin isolation required')
  }
  await page.goto(testPage.href)
  await ready()
  const before = await page.evaluate(async () => {
    const api = window.__webvspModelingReadV1
    if (!api) throw new Error('Production read API unavailable')
    return { info: await api.model.getInfo(), forbidden: window.__forbiddenFileActions }
  })
  assert.deepEqual(before.info.geometries, [], 'first model must be empty')
  assert.deepEqual(before.forbidden, [], 'no file actions before reload')
  await page.reload()
  await ready()
  const after = await page.evaluate(async oldToken => {
    const api = window.__webvspModelingReadV1
    if (!api) throw new Error('Production read API unavailable after reload')
    const info = await api.model.getInfo()
    const capture = async fn => {
      try { return { value: await fn() } }
      catch (error) { return { error: { code: error?.code, message: error?.message } } }
    }
    return {
      info,
      oldInfo: await capture(() => api.model.getInfo(oldToken)),
      oldList: await capture(() => api.geometry.list(oldToken)),
      newInfo: await capture(() => api.model.getInfo(info.identity)),
      newList: await capture(() => api.geometry.list(info.identity)),
      forbidden: window.__forbiddenFileActions,
    }
  }, before.info.identity)
  assert.deepEqual(after.info.geometries, [], 'reloaded model must be empty')
  for (const token of [before.info.identity, after.info.identity]) {
    assert.ok(typeof token.modelEpoch === 'string' && token.modelEpoch.length > 0, 'valid model epoch')
    assert.ok(typeof token.sessionId === 'string' && token.sessionId.length > 0, 'valid session ID')
  }
  assert.equal(after.info.identity.modelEpoch, before.info.identity.modelEpoch, 'fresh empty engines have the same epoch')
  assert.notEqual(after.info.identity.sessionId, before.info.identity.sessionId, 'reload creates a different session')
  assert.equal(after.oldInfo.error?.code, 'STALE_MODEL', 'old token rejected by model.getInfo')
  assert.equal(after.oldList.error?.code, 'STALE_MODEL', 'old token rejected by geometry.list')
  assert.deepEqual(after.newInfo.value, after.info, 'new token accepted by model.getInfo')
  assert.deepEqual(after.newList.value.geometries ?? after.newList.value, [], 'new token accepted by geometry.list')
  assert.deepEqual(after.forbidden, [], 'no file actions after reload')
  assert.deepEqual(errors, [], 'no page errors, downloads, or file choosers')
  console.log('PASS: reload keeps the empty model epoch but replaces the session; old token is stale and new token succeeds')
} finally {
  clearTimeout(timeout)
  await context.close()
  await browser.close()
}
