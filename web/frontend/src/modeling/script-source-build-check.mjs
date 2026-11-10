// Disposable, isolated WASM compiled with WEBVSP_SCRIPT_GUARD_TEST only; never deploy.
// Serve with vite.modeling-test.config.ts. From web/frontend:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/script-source-build-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: source build check timed out'); process.exit(1) }, 240000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  // Each page owns a fresh WASM instance: sticky state has deliberately no reset.
  for (const scenario of ['failed', 'success']) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/', { timeout: 30000 })
    assert.ok(response?.ok())
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    const result = await page.evaluate(async scenario => {
      const engine = window.__webvspEngine
      const call = (op, a = '') => engine.testCall(op, a)
      const clean = await call('scriptSourceBuildState')
      const blocked = await call('scriptSourceBuildFixture', 'blocked')
      const afterBlocked = await call('scriptSourceBuildState')
      const built = await call('scriptSourceBuildFixture', scenario)
      const afterBuild = await call('scriptSourceBuildState')
      await engine.request('POST', '/file/new')
      const afterNewModel = await call('scriptSourceBuildState')
      return { clean, blocked, afterBlocked, built, afterBuild, afterNewModel }
    }, scenario)
    assert.equal(result.clean, false, `${scenario}: fresh process`)
    assert.deepEqual(result.blocked, { blocked: true, attempted: true })
    assert.equal(result.afterBlocked, false, `${scenario}: guard blocked before build`)
    assert.deepEqual(result.built, scenario === 'failed' ? { failed: true } : { success: true, removed: true })
    assert.equal(result.afterBuild, true, `${scenario}: attempted build must taint`)
    assert.equal(result.afterNewModel, true, `${scenario}: new model must not reset`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('PASS: source build diagnostic is clean, guard-aware and sticky after failure, success, removal and new model')
} finally {
  if (browser) await browser.close()
  clearTimeout(deadline)
}
