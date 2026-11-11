// Real Chromium + WASM regression, without engine or facade mocks.
// After implementing the interface and rebuilding WASM, serve the frontend with
// vite.modeling-test.config.ts (WEBVSP_TEST_WASM_ORIGIN points at that WASM).
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/wing-shape-wasm-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5178/.
// To test an old WASM, serve the new frontend against it and set
// WEBVSP_EXPECT_OLD_ENGINE=1: wing.get must explicitly reject with ENGINE_ERROR.
// Use a disposable page/model: this script creates geometry and replaces the model.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM to a Chromium executable')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'WASM requires cross-origin isolation')
  const setup = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = window.__wingShapeTest = createBrowserModelingService()
    if ((await service.model.getInfo()).geometries.length) throw new Error('Expected a fresh disposable model')
    const geom = (await window.__webvspEngine.request('POST', '/geoms', { type: 'WING' })).id
    const identity = (await service.model.getInfo()).identity
    return { geom, identity }
  })
  const snapshot = () => page.evaluate(({ geom, identity }) => window.__wingShapeTest.wing.get(geom, identity), setup)
  if (process.env.WEBVSP_EXPECT_OLD_ENGINE === '1') {
    const failure = await page.evaluate(async ({ geom, identity }) => {
      try { return { value: await window.__wingShapeTest.wing.get(geom, identity) } }
      catch (e) { return { code: e.code, message: e.message } }
    }, setup)
    assert.equal(failure.code, 'ENGINE_ERROR', `old WASM must reject explicitly, not return placeholders: ${JSON.stringify(failure)}`)
    assert.deepEqual(errors, [])
    console.log('PASS: new frontend explicitly rejects old WASM wing shape read')
  } else {
    // WingGeom creates two XS_FOUR_SERIES stations. Native XSEC_CRV_TYPE values
    // in APIDefines.h: XS_FOUR_SERIES=7, XS_SIX_SERIES=8.
    const before = await snapshot()
    const raw = await page.evaluate(({ geom, identity }) => window.__wingShapeTest.parameter.listSurfaces(geom, identity), setup)
    assert.equal(before.surfaces.length, 1)
    assert.equal(raw.length, 1)
    assert.equal(before.surfaces[0].id, raw[0].id)
    const stations = before.surfaces[0].stations
    assert.equal(stations.length, 2, 'default wing must have two stations')
    assert.deepEqual(stations.map(s => s.id), raw[0].xsecs)
    assert.equal(new Set(stations.map(s => s.id)).size, 2)
    assert.deepEqual(stations.map(s => s.index), [0, 1])
    assert.deepEqual(stations.map(s => s.kind), ['rootAirfoilStation', 'wingSection'])
    assert.ok(stations.every(s => Number.isInteger(s.shape)), 'every shape must be a native integer')
    assert.deepEqual(stations.map(s => s.shape), [7, 7])

    // XSecGeom initializes ActiveXSec to 0. Change that root station using the
    // actual mirrored Airfoil choice, not a facade or raw engine shape write.
    await page.evaluate(id => window.__webvspEngine.request('POST', '/pick', { id }), setup.geom)
    await page.locator('.m-tabbar').getByRole('button', { name: 'Airfoil', exact: true }).click()
    const choice = page.locator('select:visible').filter({ has: page.locator('option:text-is("SIX_SERIES")') })
    await choice.waitFor({ state: 'visible' })
    assert.equal(await choice.locator('option:checked').textContent(), 'FOUR_SERIES')
    await choice.selectOption({ label: 'SIX_SERIES' })
    await page.waitForFunction(() => [...document.querySelectorAll('select')].some(s => [...s.options].some(o => o.textContent.trim() === 'SIX_SERIES') && s.selectedOptions[0]?.textContent.trim() === 'SIX_SERIES'), null, { timeout: 30000 })
    await page.waitForFunction(({ geom, identity }) => window.__wingShapeTest.wing.get(geom, identity).then(v => v.surfaces[0]?.stations[0]?.shape === 8), setup, { timeout: 30000 })
    const after = await snapshot()
    const afterRaw = await page.evaluate(({ geom, identity }) => window.__wingShapeTest.parameter.listSurfaces(geom, identity), setup)
    assert.equal(after.surfaces.length, 1)
    assert.equal(after.surfaces[0].id, before.surfaces[0].id)
    assert.deepEqual(after.surfaces[0].stations.map(s => s.id), afterRaw[0].xsecs)
    assert.deepEqual(after.surfaces[0].stations.map(s => s.index), [0, 1])
    assert.deepEqual(after.surfaces[0].stations.map(s => s.kind), ['rootAirfoilStation', 'wingSection'])
    assert.deepEqual(after.surfaces[0].stations.map(s => s.shape), [8, 7], 'GUI edit must update only the root station')

    const failures = await page.evaluate(async ({ geom, identity }) => {
      const s = window.__wingShapeTest
      const fail = async fn => { try { await fn(); return 'SUCCEEDED' } catch (e) { return e.code } }
      const invalid = await fail(() => s.wing.get(' ', identity))
      const missing = await fail(() => s.wing.get('definitely-not-a-geometry', identity))
      const fuselage = (await window.__webvspEngine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const wrongType = await fail(() => s.wing.get(fuselage, identity))
      await window.__webvspEngine.request('POST', '/file/new')
      const freshGeom = (await window.__webvspEngine.request('POST', '/geoms', { type: 'WING' })).id
      const fresh = (await s.model.getInfo()).identity
      const staleOld = await fail(() => s.wing.get(geom, identity))
      const staleExisting = await fail(() => s.wing.get(freshGeom, identity))
      const recovered = await s.wing.get(freshGeom, fresh)
      s.close()
      const closed = await fail(() => s.wing.get(freshGeom, fresh))
      return { invalid, missing, wrongType, staleOld, staleExisting, closed, fresh, shapes: recovered.surfaces[0].stations.map(x => x.shape) }
    }, setup)
    assert.equal(failures.invalid, 'INVALID_ARGUMENT')
    assert.equal(failures.missing, 'GEOMETRY_NOT_FOUND')
    assert.equal(failures.wrongType, 'UNSUPPORTED_OPERATION')
    assert.notEqual(failures.fresh.modelEpoch, setup.identity.modelEpoch)
    assert.equal(failures.staleOld, 'STALE_MODEL')
    assert.equal(failures.staleExisting, 'STALE_MODEL')
    assert.equal(failures.closed, 'SESSION_CLOSED')
    assert.deepEqual(failures.shapes, [7, 7])
    assert.deepEqual(errors, [])
    console.log('PASS: native wing shapes, GUI edit, errors and model replacement')
  }
} finally { await browser.close() }
