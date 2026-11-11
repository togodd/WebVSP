// Real WASM browser-facade regression against the existing isolated Vite server.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/protocol-facade-wasm-check.mjs
// WEBVSP_TEST_PAGE overrides http://127.0.0.1:5179/; WEBVSP_EXPECT_OLD_ENGINE=1 expects ENGINE_ERROR.
// A fresh browser context owns a disposable model; this test replaces it.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const oldEngine = process.env.WEBVSP_EXPECT_OLD_ENGINE === '1'
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const result = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const engine = window.__webvspEngine
    if (typeof engine?.testCall !== 'function') throw new Error('Dev test hook unavailable')
    const capture = async fn => {
      try { return { value: await fn() } }
      catch (error) { return { error: { code: error?.code, message: error?.message, status: error?.status } } }
    }
    const a = createBrowserModelingService()
    const b = createBrowserModelingService()
    try {
      await engine.request('POST', '/file/new')
      await engine.request('POST', '/geoms', { type: 'WING' })
      const before = await a.model.getInfo()
      const raw = await capture(() => engine.testCall('modelingProtocol'))
      const first = await capture(() => a.protocol())
      const secondHandle = await capture(() => b.protocol())
      await engine.request('POST', '/file/new')
      await engine.request('POST', '/geoms', { type: 'FUSELAGE' })
      const after = await b.model.getInfo()
      const replaced = await capture(() => a.protocol())
      a.close()
      const closed = await capture(() => a.protocol())
      const survivor = await capture(() => b.protocol())
      const c = createBrowserModelingService()
      try {
        const thirdHandle = await capture(() => c.protocol())
        b.close()
        const secondClosed = await capture(() => b.protocol())
        const thirdSurvivor = await capture(() => c.protocol())
        return { before, after, raw, first, secondHandle, replaced, closed, survivor, thirdHandle, secondClosed, thirdSurvivor }
      } finally { c.close() }
    } finally { a.close(); b.close() }
  })
  assert.notEqual(result.before.identity.modelEpoch, result.after.identity.modelEpoch, 'model actually replaced')
  assert.notDeepEqual(result.before.geometries, result.after.geometries, 'distinct disposable models')
  assert.equal(result.closed.error?.code, 'SESSION_CLOSED')
  assert.equal(result.secondClosed.error?.code, 'SESSION_CLOSED')
  const calls = [result.first, result.secondHandle, result.replaced, result.survivor, result.thirdHandle, result.thirdSurvivor]
  if (oldEngine) {
    assert.equal(result.raw.error?.message, 'unknown request: modelingProtocol', 'verify this is the old engine')
    assert.equal(result.raw.error?.status, 400)
    for (const call of calls) assert.equal(call.error?.code, 'ENGINE_ERROR', JSON.stringify(call))
  } else {
    const operations = [
      'modelDiscovery', 'model', 'bbox', 'origin', 'geomXSecs', 'fuselageXSecShapes',
      'wingXSecShapes', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm',
      'fuselageLength', 'guardedEpochV1',
    ]
    const expected = { value: { status: 'valid', operations } }
    for (const call of calls) assert.deepEqual(call, expected, 'complete stable facade protocol manifest')
    assert.deepEqual(result.raw.value?.operations, operations, 'engine returns the complete manifest')
  }
  assert.deepEqual(errors, [])
  console.log(`PASS: ${oldEngine ? 'old engine produces ENGINE_ERROR' : 'facade returns complete valid protocol'}; replacement, close and independent handles`)
} finally {
  await browser.close()
}
