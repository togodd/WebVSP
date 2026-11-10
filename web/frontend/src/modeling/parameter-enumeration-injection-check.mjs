// Disposable integration test on vite.modeling-test.config.ts. Build the WASM with
// WEBVSP_SCRIPT_GUARD_TEST, then run from web/frontend with WEBVSP_TEST_CHROMIUM set.
// Run again against a production WASM with WEBVSP_TEST_PRODUCTION=1 to check exclusion.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const deadline = setTimeout(() => { console.error('FAIL: parameter enumeration test timed out'); process.exit(1) }, 180000)
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const production = process.env.WEBVSP_TEST_PRODUCTION === '1'
  const result = await page.evaluate(async production => {
    const engine = window.__webvspEngine
    const fail = async fn => {
      try { await fn(); return { success: true } }
      catch (e) { return { code: e.code, message: e.message } }
    }
    const arm = (point, message = 'message') => engine.testCall('parmReadInjection', point, message, 0)
    if (production) return { excluded: await fail(() => arm('FindGeoms')) }
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    try {
      await engine.request('POST', '/file/new')
      const geom = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const identity = (await service.model.getInfo()).identity
      const p = service.parameter
      const xsec = (await p.listSurfaces(geom, identity))[0]?.xsecs[0]
      if (!xsec) throw new Error('Fixture has no cross section')
      const scenarios = [
        ['FindGeoms', 'geomParmIDs', geom, () => p.listGeometryParameterIds(geom, identity)],
        ['FindGeoms', 'xsecParmIDs', xsec, () => p.listCrossSectionParameterIds(xsec, identity)],
        ...['GetXSecSurfIDVec', 'GetNumXSec', 'GetXSec'].flatMap(point => [
          [point, 'geomXSecs', geom, () => p.listSurfaces(geom, identity)],
          [point, 'xsecParmIDs', xsec, () => p.listCrossSectionParameterIds(xsec, identity)],
        ]),
      ]
      const cases = []
      for (const [point, op, owner, facade] of scenarios) for (const message of ['empty', 'message']) {
        const guarded = () => engine.testCallGuarded(op, owner, '', 0, identity.modelEpoch)
        const legacy = () => engine.testCall(op, owner, '', 0)
        const baseline = await guarded()
        await arm(point, message)
        const raw = await fail(guarded)
        const recovery = await guarded()
        await arm(point, message)
        const facadeError = await fail(facade)
        const facadeRecovery = await guarded()
        await arm(point, message)
        const legacyValue = await legacy()
        const pending = await fail(guarded) // legacy must neither consume nor trigger the fault
        const afterLegacy = await guarded()
        cases.push({ point, op, message, baseline, raw, recovery, facadeError, facadeRecovery, legacyValue, pending, afterLegacy })
      }
      return { cases }
    } finally { await arm('clear'); service.close() }
  }, production)
  assert.deepEqual(pageErrors, [])
  if (production) {
    assert.notEqual(result.excluded.success, true, 'production must reject the test-only hook')
    assert.match(result.excluded.message ?? '', /unknown|unsupported/i)
  } else {
    for (const c of result.cases) {
      const label = `${c.point}/${c.op}/${c.message}`
      for (const error of [c.raw, c.pending]) {
        assert.notEqual(error.success, true, label)
        assert.notEqual(error.code, 'GEOMETRY_NOT_FOUND', label)
        assert.notEqual(error.code, 'CROSS_SECTION_NOT_FOUND', label)
        assert.match(error.message ?? '', c.message === 'empty' ? /no message/ : /Injected parameter enumeration error/, label)
      }
      assert.equal(c.facadeError.code, 'ENGINE_ERROR', label)
      for (const value of [c.recovery, c.facadeRecovery, c.legacyValue, c.afterLegacy]) assert.deepEqual(value, c.baseline, label)
    }
    console.log(`PASS: ${result.cases.length} enumeration errors, one-shot recovery and legacy isolation`)
  }
  if (production) console.log('PASS: production excludes parameter fault injection hook')
} finally { clearTimeout(deadline); await browser.close() }
