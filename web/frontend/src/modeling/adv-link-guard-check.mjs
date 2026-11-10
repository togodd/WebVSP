// Run against an isolated, disposable WASM build compiled with
// -DWEBVSP_SCRIPT_GUARD_TEST; never deploy those artifacts. Start the modeling
// test page with vite.modeling-test.config.ts and WEBVSP_TEST_WASM_ORIGIN
// pointing at that build. From web/frontend:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium WEBVSP_TEST_PAGE=http://127.0.0.1:5178/ \
//   node src/modeling/adv-link-guard-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  // Entire fixture and all observations stay on the engine thread, and the
  // victim is distinct from the parameter owner so unguarded deletion is safe.
  for (let run = 0; run < 2; run++) {
    const result = await page.evaluate(() => window.__webvspEngine.testCall('advLinkGuardCheck'))
    assert.equal(result.built, true)
    assert.equal(result.belowAlive, true)
    assert.equal(result.initial, false)
    assert.equal(result.attempted, true)
    assert.equal(result.guardedAlive, true)
    assert.equal(result.unguardedAlive, false)
    assert.equal(result.afterCleanup, result.before)
  }
  assert.deepEqual(errors, [])
  console.log('PASS: real AdvLink threshold deletion blocked by ScriptMgr guard in WASM')
} finally { await browser.close() }
