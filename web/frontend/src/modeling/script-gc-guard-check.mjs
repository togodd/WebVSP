// ONLY a disposable, isolated WASM build compiled with WEBVSP_SCRIPT_GUARD_TEST.
// Never deploy the artifacts or point this at a real user session/model. Serve the
// modeling test page via vite.modeling-test.config.ts and WEBVSP_TEST_WASM_ORIGIN.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium \
//   WEBVSP_TEST_PAGE=http://127.0.0.1:5178/ node src/modeling/script-gc-guard-check.mjs
// This probe documents a guard limitation, not a guarantee of safe guarded writes.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: GC probe timed out'); process.exit(1) }, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  // New browser, context, page and WASM instance; no model is loaded or reset.
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/', { timeout: 30000 })
  assert.ok(response?.ok(), 'test page must load')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(() => window.__webvspEngine.testCall('scriptGcGuardCheck'))
  assert.equal(result.executeRc, 0, 'cycle created outside guard')
  assert.equal(result.gcRc, 0, 'full collection completed')
  assert.equal(result.aliveBefore, true)
  assert.equal(result.destroyedBefore, 0, 'no premature destructor')
  assert.equal(result.initial, false)
  assert.equal(result.destroyedAfter, 1, 'destructor executed during GC')
  assert.equal(result.aliveAfter, false, 'independent BLANK victim deleted')
  assert.equal(result.attempted, false, 'GC bypasses ScriptMgr guard tracking')
  assert.deepEqual(errors, [])
  console.log('PASS: full GC ran script destructor and deleted victim without marking guard attempted')
} finally {
  try { if (browser) await browser.close() } finally { clearTimeout(deadline) }
}
