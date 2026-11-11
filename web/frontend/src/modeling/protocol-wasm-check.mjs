// Real WASM protocol regression against the existing Vite modeling test server.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/protocol-wasm-check.mjs
// Set WEBVSP_EXPECT_OLD_ENGINE=1 to require the old engine's explicit unknown-request error.
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/. A fresh browser owns a disposable model.
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
    const engine = window.__webvspEngine
    if (typeof engine?.testCall !== 'function' || typeof engine?.testCallGuarded !== 'function') throw new Error('Dev test hooks unavailable')
    const capture = async fn => {
      try { return { value: await fn() } }
      catch (e) { return { error: { message: e.message, status: e.status, code: e.code, outcome: e.outcome, actual: e.actual } } }
    }
    const geom = await engine.testCall('addGeom', 'FUSELAGE')
    const before = await engine.testCall('model')
    const first = await capture(() => engine.testCall('modelingProtocol'))
    const second = await capture(() => engine.testCall('modelingProtocol'))
    const guarded = await capture(() => engine.testCallGuarded('modelingProtocol', '', '', 0, before.modelEpoch))
    const after = await engine.testCall('model')
    return { geom, before, first, second, guarded, after }
  })
  assert.ok(result.geom.id, 'nonempty disposable model')
  assert.equal(result.before.modelEpochValid, true)
  assert.match(result.before.modelEpoch, /^(0|[1-9]\d*)$/)
  assert.deepEqual(result.after, result.before, 'protocol calls must not change model or identity')
  if (oldEngine) {
    for (const call of [result.first, result.second]) {
      assert.equal(call.error?.message, 'unknown request: modelingProtocol', 'old engine must explicitly reject the operation')
      assert.equal(call.error?.status, 400)
    }
  } else {
    const expected = { protocol: 'webvsp-modeling', version: 1, operations: [
      'modelDiscovery', 'model', 'bbox', 'origin', 'geomXSecs', 'fuselageXSecShapes',
      'wingXSecShapes', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm',
      'fuselageLength', 'guardedEpochV1',
    ] }
    assert.deepEqual(result.first, { value: expected }, 'exact protocol manifest')
    assert.deepEqual(result.second, { value: expected }, 'manifest is stable across calls')
  }
  assert.equal(result.guarded.error?.message, 'Operation is not permitted by the guarded bridge')
  assert.equal(result.guarded.error?.status, 400)
  assert.equal(result.guarded.error?.outcome, 'not_written')
  assert.equal(result.guarded.error?.actual, null)
  assert.deepEqual(errors, [])
  console.log(`PASS: ${oldEngine ? 'old engine explicitly rejects modelingProtocol' : 'exact modelingProtocol manifest'}; guarded request rejected and model unchanged`)
} finally {
  await browser.close()
}
