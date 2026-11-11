// Real browser + WASM regression; no adapter, engine, or shape mocks.
// Prerequisites: implement native integer section.shape end-to-end, rebuild vsp.wasm,
// and serve the frontend with vite.modeling-test.config.ts and cross-origin isolation.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/fuselage-shape-wasm-check.mjs
// Optional: WEBVSP_TEST_PAGE (default http://127.0.0.1:5179/).
// To check compatibility failure, serve the NEW frontend with an OLD engine WASM and
// run with WEBVSP_EXPECT_OLD_ENGINE=1. This must reject rather than return null/shapes.
// Use disposable servers/models: this script creates geometry and replaces the model.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM to a Chromium executable')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'WASM requires cross-origin isolation')
  const setup = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = window.__fuselageShapeTest = createBrowserModelingService()
    const initial = await service.model.getInfo()
    if (initial.geometries.length) throw new Error('Expected a fresh disposable model')
    const geom = (await window.__webvspEngine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
    const identity = (await service.model.getInfo()).identity
    return { geom, identity }
  })
  const snapshot = () => page.evaluate(({ geom, identity }) => window.__fuselageShapeTest.fuselage.get(geom, identity), setup)
  if (process.env.WEBVSP_EXPECT_OLD_ENGINE === '1') {
    const failure = await page.evaluate(async ({ geom, identity }) => {
      try { return { value: await window.__fuselageShapeTest.fuselage.get(geom, identity) } }
      catch (e) { return { code: e.code } }
    }, setup)
    assert.equal(failure.code, 'ENGINE_ERROR', `old engine must fail explicitly: ${JSON.stringify(failure)}`)
    assert.deepEqual(errors, [])
    console.log('PASS: new frontend rejects unsupported old engine shape read')
  } else {
    // FuselageGeom's constructor and APIDefines.h: POINT=0, ELLIPSE=2.
    const before = await snapshot()
    const raw = await page.evaluate(({ geom, identity }) => window.__fuselageShapeTest.parameter.listSurfaces(geom, identity), setup)
    assert.equal(before.surfaces.length, 1)
    assert.equal(before.surfaces[0].id, raw[0].id)
    assert.deepEqual(before.surfaces[0].sections.map(s => s.id), raw[0].xsecs)
    assert.deepEqual(before.surfaces[0].sections.map(s => s.index), [0, 1, 2, 3, 4])
    assert.deepEqual(before.surfaces[0].sections.map(s => s.shape), [0, 2, 2, 2, 0])
    assert.equal(new Set(raw[0].xsecs).size, 5)

    // Select the fuselage and use OpenVSP's actual mirrored XSec controls. A fresh
    // fuselage selects index 0; its right arrow selects the first ellipse (index 1).
    await page.evaluate(id => window.__webvspEngine.request('POST', '/pick', { id }), setup.geom)
    await page.locator('.m-tabbar').getByRole('button', { name: 'XSec', exact: true }).click()
    const choice = page.locator('select').filter({ has: page.locator('option:text-is("ROUNDED_RECTANGLE")') }).first()
    await choice.waitFor({ state: 'visible' })
    await page.locator('.m-w.m-button[title*="Index:ActiveXSec"] button:visible').filter({ hasText: /^>$/ }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('select')].some(s => [...s.options].some(o => o.textContent.trim() === 'ROUNDED_RECTANGLE') && s.selectedOptions[0]?.textContent.trim() === 'ELLIPSE'), null, { timeout: 30000 })
    await choice.selectOption({ label: 'ROUNDED_RECTANGLE' })
    // Wait on GUI readback, then check shape and IDs across the actual API boundary.
    await page.waitForFunction(() => [...document.querySelectorAll('select')].some(s => [...s.options].some(o => o.textContent.trim() === 'ROUNDED_RECTANGLE') && s.selectedOptions[0]?.textContent.trim() === 'ROUNDED_RECTANGLE'), null, { timeout: 30000 })
    await page.waitForFunction(({ geom, identity }) => window.__fuselageShapeTest.fuselage.get(geom, identity).then(v => v.surfaces[0]?.sections[1]?.shape === 4), setup, { timeout: 30000 })
    const after = await snapshot()
    const sections = after.surfaces[0].sections
    assert.deepEqual(sections.map(s => s.shape), [0, 4, 2, 2, 0], 'GUI edit must affect only the chosen XSec')
    assert.deepEqual(sections.map(s => s.index), [0, 1, 2, 3, 4])
    assert.equal(after.surfaces[0].id, before.surfaces[0].id)
    assert.deepEqual(sections.map(s => s.id), (await page.evaluate(({ geom, identity }) => window.__fuselageShapeTest.parameter.listSurfaces(geom, identity), setup))[0].xsecs)

    const failures = await page.evaluate(async ({ geom, identity }) => {
      const s = window.__fuselageShapeTest
      const fail = async fn => { try { await fn(); return 'SUCCEEDED' } catch (e) { return e.code } }
      const invalid = await fail(() => s.fuselage.get(' ', identity))
      const missing = await fail(() => s.fuselage.get('definitely-not-a-geometry', identity))
      const wing = (await window.__webvspEngine.request('POST', '/geoms', { type: 'WING' })).id
      const wrongType = await fail(() => s.fuselage.get(wing, identity))
      await window.__webvspEngine.request('POST', '/file/new')
      const freshGeom = (await window.__webvspEngine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const fresh = (await s.model.getInfo()).identity
      const staleOld = await fail(() => s.fuselage.get(geom, identity))
      const staleExisting = await fail(() => s.fuselage.get(freshGeom, identity))
      const recovered = await s.fuselage.get(freshGeom, fresh)
      s.close()
      const closed = await fail(() => s.fuselage.get(freshGeom, fresh))
      return { invalid, missing, wrongType, staleOld, staleExisting, closed, fresh, shapes: recovered.surfaces[0].sections.map(x => x.shape) }
    }, setup)
    assert.equal(failures.invalid, 'INVALID_ARGUMENT')
    assert.equal(failures.missing, 'GEOMETRY_NOT_FOUND')
    assert.equal(failures.wrongType, 'UNSUPPORTED_OPERATION')
    assert.notEqual(failures.fresh.modelEpoch, setup.identity.modelEpoch)
    assert.equal(failures.staleOld, 'STALE_MODEL')
    assert.equal(failures.staleExisting, 'STALE_MODEL')
    assert.equal(failures.closed, 'SESSION_CLOSED')
    assert.deepEqual(failures.shapes, [0, 2, 2, 2, 0])
    assert.deepEqual(errors, [])
    console.log('PASS: native fuselage shapes, GUI edit, errors and model replacement')
  }
} finally { await browser.close() }
