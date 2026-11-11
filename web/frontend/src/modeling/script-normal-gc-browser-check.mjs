// ONLY disposable WASM compiled with WEBVSP_SCRIPT_GUARD_TEST. Never deploy it.
// Serve via vite.modeling-test.config.ts with WEBVSP_TEST_WASM_ORIGIN set to the
// test build; WEBVSP_TEST_CHROMIUM and optionally WEBVSP_TEST_PAGE select browser/page.
// Each scenario uses a fresh isolated browser context and WASM instance. These are
// observations of specific executions, not a proof that guarded writes are safe.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: normal GC probe timed out'); process.exit(1) }, 360000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  for (const op of ['scriptNormalGcPositive', 'scriptNormalGcAutoOff', 'scriptNormalGcAutoOn']) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/', { timeout: 30000 })
      assert.ok(response?.ok(), `${op}: test page must load`)
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      assert.equal(await page.evaluate(() => crossOriginIsolated), true)
      const result = await page.evaluate(op => window.__webvspEngine.testCall(op), op)
      // Print the observed data even if a subsequent assertion fails.
      console.log(JSON.stringify({ op, result, errors }))
      assert.equal(result.scenario, op)
      assert.equal(result.executeRc, 0)
      assert.equal(result.autoGc, op === 'scriptNormalGcAutoOn' ? 1 : 0)
      assert.equal(result.destroyedBefore, 0)
      assert.ok(result.gcBefore.current > 0, 'cycle exists before observation')
      assert.ok([0, 1].includes(result.destroyedAfter), 'record actual destructor count')
      assert.equal(result.errors, '')
      if (op === 'scriptNormalGcPositive') {
        assert.equal(result.gcRc, 0, 'unguarded full GC completed')
        assert.equal(result.destroyedAfter, 1, 'positive control must run destructor')
        assert.equal(result.operation, null)
      } else {
        assert.equal(result.gcRc, null, 'no forced GC in guarded operation')
        assert.equal(result.operation?.ok, true, 'real guarded addGeom succeeded')
        assert.ok(result.operation?.value?.id, 'real guarded addGeom returned an id')
      }
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
  console.log('PASS: positive GC control and guarded addGeom observations; no safety conclusion')
} finally {
  try { if (browser) await browser.close() } finally { clearTimeout(deadline) }
}
