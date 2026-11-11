// Real browser/WASM fault regression, using a disposable model and test-only WASM
// built with WEBVSP_SCRIPT_GUARD_TEST. No WASM is built or exported by this test.
// Serve vite.modeling-test.config.ts, then from web/frontend run:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/fuselage-shape-injection-check.mjs
// Optional: WEBVSP_TEST_PAGE (default http://127.0.0.1:5179/).
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const deadline = setTimeout(() => { console.error('FAIL: fuselage shape injection test timed out'); process.exit(1) }, 180000)
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    // The shape reader is internal to the public fuselage facade; wire its real
    // parameter service directly to the guarded browser/WASM bridge as well.
    const { createParameterService } = await import('/src/modeling/parameterService.ts')
    const arm = (point, message = 'message') => engine.testCall('parmReadInjection', point, message, 0)
    const fail = async fn => {
      try { return { success: true, value: await fn() } }
      catch (e) { return { code: e.code, message: e.message } }
    }
    try {
      await engine.request('POST', '/file/new')
      const geom = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const wing = (await engine.request('POST', '/geoms', { type: 'WING' })).id
      const identity = (await service.model.getInfo()).identity
      const guarded = (id = geom, epoch = identity.modelEpoch) => engine.testCallGuarded('fuselageXSecShapes', id, '', 0, epoch)
      const legacy = () => engine.testCall('fuselageXSecShapes', geom, '', 0)
      const parameterService = createParameterService({ fuselageShapes: id => guarded(id) })
      const parameter = () => parameterService.listFuselageShapes(geom, identity)
      const fuselage = () => service.fuselage.get(geom, identity)
      const baseline = await guarded()
      const parameterBaseline = await parameter()
      const fuselageBaseline = await fuselage()
      const cases = []
      const points = ['FindGeoms', 'GetXSecSurfIDVec', 'GetNumXSec', 'GetXSec', 'GetXSecShape']
      for (const point of points) for (const message of ['empty', 'message']) {
        await arm(point, message)
        const raw = await fail(() => guarded())
        const recovery = await guarded()
        await arm(point, message)
        const facadeError = await fail(parameter)
        const facadeRecovery = await parameter()
        // FindGeoms is also used by the earlier geometry/length reads of fuselage.get;
        // exercise that point through the direct parameter facade above instead.
        let compositeError, compositeRecovery
        if (point !== 'FindGeoms') {
          await arm(point, message)
          compositeError = await fail(fuselage)
          compositeRecovery = await fuselage()
        }
        await arm(point, message)
        const legacyValue = await legacy()
        const pending = await fail(() => guarded())
        const afterLegacy = await guarded()
        cases.push({ point, message, raw, recovery, facadeError, facadeRecovery, compositeError, compositeRecovery, legacyValue, pending, afterLegacy })
      }
      // A non-fuselage must reject before any XSec enumeration and leave that
      // one-shot fault pending. FindGeoms is deliberately excluded here.
      const wrong = []
      for (const point of points.slice(1)) for (const message of ['empty', 'message']) {
        await arm(point, message)
        const rejected = await fail(() => guarded(wing))
        const pending = await fail(() => guarded())
        const recovery = await guarded()
        wrong.push({ point, message, rejected, pending, recovery })
      }
      const wrongFacade = await fail(() => service.fuselage.get(wing, identity))
      await engine.request('POST', '/file/new')
      const freshGeom = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const fresh = (await service.model.getInfo()).identity
      const freshRead = () => guarded(freshGeom, fresh.modelEpoch)
      const freshBaseline = await freshRead()
      const stale = []
      for (const point of points) for (const message of ['empty', 'message']) {
        await arm(point, message)
        const rejected = await fail(() => guarded(freshGeom, identity.modelEpoch))
        const pending = await fail(freshRead)
        const recovery = await freshRead()
        stale.push({ point, message, rejected, pending, recovery })
      }
      const staleFacade = await fail(() => service.fuselage.get(freshGeom, identity))
      return { identity, fresh, baseline, parameterBaseline, fuselageBaseline, cases, wrong, wrongFacade, freshBaseline, stale, staleFacade }
    } finally { await arm('clear'); service.close() }
  })
  const fault = (error, message, label) => {
    assert.notEqual(error.success, true, label + ': partial/success result')
    assert.notEqual(error.code, 'GEOMETRY_NOT_FOUND', label)
    assert.match(error.message ?? '', message === 'empty' ? /no message/ : /Injected parameter enumeration error/, label)
  }
  assert.ok(result.baseline.length > 0 && result.baseline[0].xsecs.length > 1, 'fixture must reach section and shape reads')
  assert.deepEqual(result.baseline[0].xsecs.map(x => x.shape), [0, 2, 2, 2, 0])
  assert.deepEqual(result.parameterBaseline, result.baseline)
  for (const c of result.cases) {
    const label = `${c.point}/${c.message}`
    fault(c.raw, c.message, label)
    fault(c.pending, c.message, label + '/legacy')
    assert.equal(c.facadeError.code, 'ENGINE_ERROR', label)
    assert.notEqual(c.facadeError.success, true, label)
    assert.deepEqual(c.recovery, result.baseline, label)
    assert.deepEqual(c.facadeRecovery, result.parameterBaseline, label)
    assert.deepEqual(c.legacyValue, result.baseline, label)
    assert.deepEqual(c.afterLegacy, result.baseline, label)
    if (c.compositeError) {
      assert.equal(c.compositeError.code, 'ENGINE_ERROR', label)
      assert.notEqual(c.compositeError.success, true, label)
      assert.deepEqual(c.compositeRecovery, result.fuselageBaseline, label)
    }
  }
  for (const c of result.wrong) {
    const label = `wrong/${c.point}/${c.message}`
    assert.notEqual(c.rejected.success, true, label)
    assert.match(c.rejected.message ?? '', /not a fuselage/i, label)
    fault(c.pending, c.message, label)
    assert.deepEqual(c.recovery, result.baseline, label)
  }
  assert.equal(result.wrongFacade.code, 'UNSUPPORTED_OPERATION')
  assert.notEqual(result.identity.modelEpoch, result.fresh.modelEpoch)
  for (const c of result.stale) {
    const label = `stale/${c.point}/${c.message}`
    assert.equal(c.rejected.code, 'STALE_MODEL', label)
    fault(c.pending, c.message, label)
    assert.deepEqual(c.recovery, result.freshBaseline, label)
  }
  assert.equal(result.staleFacade.code, 'STALE_MODEL')
  assert.deepEqual(pageErrors, [])
  console.log(`PASS: ${result.cases.length} shape injection cases, ${result.wrong.length} wrong-geometry and ${result.stale.length} stale-epoch cases`)
} finally { clearTimeout(deadline); await browser.close() }
