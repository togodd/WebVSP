// Only isolated disposable test WASM. --no-sandbox is NOT a browser sandbox.
// A matching token is an operator guard, not authentication. Never use a user server.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const { WEBVSP_TEST_CHROMIUM: executablePath, WEBVSP_TEST_PAGE: address, WEBVSP_TEST_TOKEN: token } = process.env
if (!executablePath || !address || !token || token.length < 32) throw new Error('Require Chromium, explicit loopback URL and disposable server token')
const url = new URL(address)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Require explicit 127.0.0.1 HTTP disposable test server')
const response = await fetch(new URL('/__vm_guard_test_token', url), { signal: AbortSignal.timeout(5000) })
assert.equal(response.ok, true)
assert.equal(await response.text(), token, 'disposable server token mismatch')
const expected = { baseline: false, created: true, initial: false, cacheSame: true,
  afterCache: false, changedRejected: true, afterChanged: true, stickyAfterCache: true,
  removeRejected: true, afterRemove: true, intact: true, removeInitial: false,
  removeAloneRejected: true, removeAloneAttempted: true, removed: true, absent: true }
for (const [op, expectedError] of [
  ['scriptModuleCacheGuardCheck', null],
  ['scriptModuleCacheGuardCreateFailure', 'Tainted disposable instance: fixture creation failed'],
  ['scriptModuleCacheGuardRemoveFailure', 'Tainted disposable instance: injected cleanup failure'],
]) {
  let browser
  let timer
  let expired = false
  const timed = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('probe timeout')) }, 120000) })
  try {
    const run = async () => {
      browser = await chromium.launch({ executablePath, headless: true, timeout: 30000, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
      // A late launch after the watchdog must not continue into a new test.
      if (expired) { await browser.close(); return }
      const page = await browser.newPage({ serviceWorkers: 'block' })
      if (expired) return
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      assert.ok((await page.goto(url.href, { timeout: 30000 }))?.ok())
      assert.equal(await page.evaluate(() => crossOriginIsolated), true)
      await page.waitForSelector('[data-ready="1"]', { timeout: 90000 })
      if (expectedError) {
        const error = await page.evaluate(async op => { try { await window.__webvspEngine.testCall(op); return null } catch (e) { return { name: e.constructor.name, message: e.message, status: e.status } } }, op)
        assert.deepEqual(error, { name: 'WasmEngineError', message: expectedError, status: 400 })
      } else {
        const result = await page.evaluate(op => window.__webvspEngine.testCall(op), op)
        console.log('clean result:', JSON.stringify(result))
        assert.deepEqual(result, expected)
      }
      // Only a one-shot rejection check may follow: no other engine requests.
      // Tainted is a caller obligation; the engine does not block unrelated jobs.
      const second = await page.evaluate(async () => { try { await window.__webvspEngine.testCall('scriptModuleCacheGuardCheck'); return null } catch (e) { return { name: e.constructor.name, message: e.message, status: e.status } } })
      assert.deepEqual(second, { name: 'WasmEngineError', message: 'Disposable probe already used; discard instance', status: 400 })
      assert.deepEqual(errors, [])
    }
    await Promise.race([run(), timed])
    console.log(`PASS: ${op}`)
  } finally {
    clearTimeout(timer)
    if (browser) {
      // Bound the close wait and clear its timer on both success and failure.
      // Timeout does not prove the OS browser process tree has exited.
      let closeTimer
      try {
        await Promise.race([browser.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('browser close timed out; verify and terminate browser process tree')), 10000) })])
      } finally { clearTimeout(closeTimer) }
    }
  }
}
