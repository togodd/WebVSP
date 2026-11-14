// Run against a production WASM build compiled WITHOUT WEBVSP_SCRIPT_GUARD_TEST.
// Serve the Vite modeling test page using vite.modeling-test.config.ts, with
// WEBVSP_TEST_WASM_ORIGIN pointing at that production artifact. The Vite DEV-only
// JavaScript testCall hook is used solely to test the WASM request dispatcher;
// this does not assert that the hook exists in a production JavaScript bundle.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium \
//   WEBVSP_TEST_PAGE=http://127.0.0.1:5179/ node src/modeling/production-hooks-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
// A stalled WASM request or browser.close must not hang the test indefinitely.
const deadline = setTimeout(() => {
  console.error('FAIL: production hooks check timed out')
  process.exit(1)
}, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  // Use a separate context and blank same-origin document: the app must not
  // initialize or drain this instance, and no service worker may intercept it.
  const rawContext = await browser.newContext({ serviceWorkers: 'block' })
  const rawPage = await rawContext.newPage()
  await rawPage.route('**/__production_hooks_blank__', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>Production WASM export check</title>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' },
  }))
  const base = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  const blankResponse = await rawPage.goto(new URL('/__production_hooks_blank__', base).href)
  assert.ok(blankResponse?.ok(), 'isolated blank page must load successfully')
  const barrierTypes = await rawPage.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required')
    const { default: createVspModule } = await import('/wasm/vsp.js')
    const vsp = await createVspModule()
    return Object.fromEntries(['testBarrierArm', 'testBarrierState', 'testBarrierRelease']
      .map(name => [name, typeof vsp[name]]))
  })
  for (const [name, type] of Object.entries(barrierTypes)) {
    assert.equal(type, 'undefined', `${name}: must not be exported by production WASM`)
    console.log(`PASS: ${name} is absent from the initialized production module`)
  }
  await rawContext.close()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
  page.on('requestfailed', request => errors.push(`request failed: ${request.url()}: ${request.failure()?.errorText}`))
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`) })
  const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/', { timeout: 30000 })
  assert.ok(response?.ok(), 'modeling test page must load successfully')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine?.testCall !== 'function') throw new Error('Vite DEV testCall hook is unavailable; use the modeling test page')
    const call = (op, a = '', b = '', value = 0) => engine.testCall(op, a, b, value)
    // This page is disposable. A nonempty model makes unintended deletion or
    // mutation detectable, including changes that preserve the geometry count.
    await engine.request('POST', '/file/new')
    const { id } = await call('addGeom', 'FUSELAGE')
    if (!id) throw new Error('Failed to create sentinel geometry')
    const length = await call('fuselageLength', id)
    if (!length?.id) throw new Error('Failed to read sentinel parameter')
    const snapshot = async () => ({
      model: await call('model'),
      origin: await call('origin', id),
      length: await call('geomParm', id, length.id),
    })
    const cases = [
      ['guardedWriteInjection', 'pre'],
      ['guardedWriteErrorInjection', 'move'],
      ['scriptPreflightFixture', 'advlink'],
      ['scriptGuardCheck', ''],
      ['scriptModuleCacheGuardCheck', ''],
      ['scriptSourceBuildState', ''],
      ['scriptSourceBuildFixture', 'success'],
      ['scriptGcGuardCheck', ''],
      ['scriptNormalGcPositive', ''],
      ['scriptNormalGcAutoOff', ''],
      ['scriptNormalGcAutoOn', ''],
      ['scriptParmGcPositive', 'disposable-empty-model'],
      ['scriptParmGcAutoOff', 'disposable-empty-model'],
      ['scriptParmGcAutoOn', 'disposable-empty-model'],
      ['scriptSetterGcProbe', 'disposable-empty-model'],
      ['scriptReleaseGuardCheck', ''],
      ['advLinkGuardCheck', ''],
      ['storedGeomTypesCheck', ''],
      ['parameterDetachedFixture', id],
      ['parameterDetachedCleanup', id],
      ['serializerInjection', 'model:early'],
      ['parmReadInjection', 'FindGeoms'],
      ['protocolErrorStackProbe', ''],
      ['webvspDefinitelyUnknownOperation', ''],
    ]
    const results = []
    for (const [op, arg] of cases) {
      const before = await snapshot()
      let error
      try { await call(op, arg); error = null }
      catch (e) { error = { message: e.message, status: e.status } }
      const after = await snapshot()
      results.push({ op, before, error, after })
    }
    return { id, results }
  })
  assert.ok(result.id)
  assert.equal(result.results.length, 24)
  for (const { op, before, error, after } of result.results) {
    assert.deepEqual(error, { message: `unknown request: ${op}`, status: 400 }, `${op}: must be rejected by the engine as unknown`)
    assert.equal(before.model.modelEpochValid, true, `${op}: valid model identity`)
    assert.ok(before.model.geoms.some(geom => geom.id === result.id), `${op}: sentinel present`)
    assert.deepEqual(after, before, `${op}: model, origin and parameter must remain unchanged`)
    console.log(`PASS: ${op} rejected without model changes`)
  }
  assert.deepEqual(errors, [], 'browser, console and network errors')
  console.log('PASS: production WASM excludes all tested test-only operations')
} finally {
  if (browser) await browser.close()
  clearTimeout(deadline)
}
