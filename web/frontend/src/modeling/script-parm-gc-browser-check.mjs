// ONLY disposable WEBVSP_SCRIPT_GUARD_TEST WASM; never deploy or use a user session.
// Set WEBVSP_TEST_CHROMIUM and optionally WEBVSP_TEST_PAGE, serving the modeling
// test page with WEBVSP_TEST_WASM_ORIGIN pointing at the disposable test build.
// Each scenario gets a new context and engine. Counts are observations, not a
// proof of safety or absence of reentrancy between samples.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: parameter GC probe timed out'); process.exit(1) }, 360000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  for (const op of ['scriptParmGcPositive', 'scriptParmGcAutoOff', 'scriptParmGcAutoOn']) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/', { timeout: 30000 })
      assert.ok(response?.ok(), `${op}: test page must load`)
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      assert.equal(await page.evaluate(() => crossOriginIsolated), true)
      const result = await page.evaluate(op => window.__webvspEngine.testCall(op, 'disposable-empty-model'), op)
      console.log(JSON.stringify({ op, result, errors }))
      assert.equal(result.scenario, op)
      assert.equal(result.executeRc, 0)
      assert.equal(result.autoGc, op === 'scriptParmGcAutoOn' ? 1 : 0)
      assert.equal(result.destroyedBefore, 0)
      assert.ok(result.gcBefore.current > 0)
      assert.ok([0, 1].includes(result.destroyedAfter))
      assert.equal(result.errors, '')
      if (op === 'scriptParmGcPositive') {
        assert.equal(result.gcRc, 0)
        assert.equal(result.destroyedAfter, 1)
        assert.ok(result.gcAfter.destroyed > result.gcBefore.destroyed)
      } else {
        assert.equal(result.gcRc, null)
      }
      assert.equal(result.operation.length, 12, 'single candidate and all subsequent alternating writes succeed')
      for (const [index, sample] of result.operation.entries()) {
        assert.equal(sample.requested, index % 2 ? 10 : 12)
        assert.equal(sample.reply.ok, true, `write ${index} succeeded`)
        assert.equal(sample.reply.value.actual, sample.requested, `write ${index} returned actual value`)
        assert.ok([0, 1].includes(sample.destroyed))
        for (const field of ['current', 'destroyed', 'detected', 'newObjects', 'newDestroyed']) {
          assert.ok(Number.isSafeInteger(sample.gc[field]) && sample.gc[field] >= 0, `${field} is a GC count`)
        }
      }
      assert.deepEqual(result.operation.at(-1).gc, result.gcAfter)
      assert.equal(result.operation.at(-1).destroyed, result.destroyedAfter)
      const retryError = await page.evaluate(async op => {
        try { await window.__webvspEngine.testCall(op, 'disposable-empty-model'); return null } catch (error) { return error.message }
      }, op)
      assert.match(retryError ?? '', /fresh disposable empty test module/, 'probe is one-shot')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
  console.log('PASS: guarded parameter write GC observations; no safety conclusion')
} finally {
  try { if (browser) await browser.close() } finally { clearTimeout(deadline) }
}
