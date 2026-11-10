// Use a disposable WASM build tree configured with the normal SDK/toolchain and libraries.
// For example, after the normal initial build, in an isolated copy of its build tree:
//   cmake -S src -B build/vsp-wasm -DCMAKE_CXX_FLAGS=-DWEBVSP_SCRIPT_GUARD_TEST
//   cmake --build build/vsp-wasm --target vsp_wasm
// Copy build/vsp-wasm/wasm_engine/vsp.{js,wasm} to the test server's public/wasm/.
// Start Vite with vite.modeling-test.config.ts, then from web/frontend run:
//   WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/script-guard-check.mjs
// Never deploy these test artifacts. Production builds must omit the define.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  // A single engine-thread job owns the guards and all observations; no GUI pumping
  // or other request can interleave with their lifetimes.
  const result = await page.evaluate(() => window.__webvspEngine.testCall('scriptGuardCheck'))
  assert.equal(result.unguardedRc, 0)
  assert.equal(result.afterUnguarded, result.before + 1)
  assert.equal(result.outerInitial, false)
  assert.equal(result.innerInitial, false)
  assert.notEqual(result.nestedRc, 0)
  assert.equal(result.innerAttempted, true)
  assert.equal(result.outerNested, true)
  assert.equal(result.outerAttempted, true)
  assert.equal(result.afterNested, result.afterUnguarded)
  assert.notEqual(result.innerDestroyedRc, 0)
  assert.equal(result.afterInner, result.afterUnguarded)
  assert.notEqual(result.nonLifoRc, 0)
  assert.equal(result.nonLifoAttempted, true)
  assert.notEqual(result.unwindRc, 0)
  assert.equal(result.unwindAttempted, true)
  assert.equal(result.afterExtraGuards, result.afterUnguarded)
  assert.equal(result.restoredRc, 0)
  assert.equal(result.afterRestored, result.before + 2)
  assert.equal(result.afterCleanup, result.before)
  assert.deepEqual(errors, [])
  console.log('PASS: ExecuteScriptGuard real WASM side effects, nested attempts, and restoration')
} finally { await browser.close() }
