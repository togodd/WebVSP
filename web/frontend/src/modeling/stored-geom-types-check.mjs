// Disposable isolated WASM build with -DWEBVSP_SCRIPT_GUARD_TEST; never deploy it.
// Serve vite.modeling-test.config.ts with WEBVSP_TEST_WASM_ORIGIN set to that build.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/stored-geom-types-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: stored geom types check timed out'); process.exit(1) }, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('requestfailed', r => errors.push(`request failed: ${r.url()}: ${r.failure()?.errorText}`))
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`) })
  const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/', { timeout: 30000 })
  assert.ok(response?.ok())
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine?.testCall !== 'function') throw new Error('Use the Vite modeling test page')
    await engine.request('POST', '/file/new')
    const { id } = await engine.testCall('addGeom', 'FUSELAGE', '', 0)
    if (!id) throw new Error('Failed to create sentinel')
    const snapshot = async () => ({ model: await engine.testCall('model', '', '', 0), origin: await engine.testCall('origin', id, '', 0) })
    const before = await snapshot()
    const first = await engine.testCall('storedGeomTypesCheck', '', '', 0)
    const second = await engine.testCall('storedGeomTypesCheck', '', '', 0)
    return { before, first, second, after: await snapshot() }
  })
  assert.deepEqual(result.first, {
    known: Array(20).fill(true), rejected: Array(7).fill(false), empty: true,
    allKnown: true, mixed: false, emptyStore: true, nullStore: false,
  })
  assert.deepEqual(result.second, result.first, 'repeatable without fixture mutation')
  assert.deepEqual(result.after, result.before, 'diagnostic must not change the model')
  assert.deepEqual(errors, [], 'browser, console and network errors')
  console.log('PASS: known, custom/base/NUM/unknown, mixed, empty and null store checks')
} finally {
  if (browser) await browser.close()
  clearTimeout(deadline)
}
