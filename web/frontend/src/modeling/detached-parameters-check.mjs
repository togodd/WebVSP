// Destructive: use a disposable model in an isolated test server, not a user's session.
// Do not delete/replace geoms between fixture creation and cleanup; pointer/ID ABA is possible.
// Requires WASM built with WEBVSP_SCRIPT_GUARD_TEST. Restart Vite after rebuilding WASM.
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/detached-parameters-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const engine = window.__webvspEngine
    const service = createBrowserModelingService()
    const failure = async f => {
      try { await f(); return { code: 'SUCCEEDED' } }
      catch (e) { return { code: e.code, outcome: e.outcome, actual: e.actual } }
    }
    let detached
    try {
      await engine.request('POST', '/file/new')
      const body = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const child = (await engine.request('POST', '/geoms', { type: 'WING', parent: body })).id
      const blank = (await engine.request('POST', '/geoms', { type: 'BLANK' })).id
      const identity = (await service.model.getInfo()).identity
      const originalLength = await service.parameter.getFuselageLength(body, identity)
      const originalIds = await service.parameter.listGeometryParameterIds(body, identity)
      const childIds = await service.parameter.listGeometryParameterIds(child, identity)
      const emptySurfaces = await service.parameter.listSurfaces(blank, identity)
      detached = await engine.testCall('parameterDetachedFixture', body)
      const detachedFixtureId = detached.id
      const detachedSection = detached.surfaces[0].xsecs[0]
      const tree = await service.geometry.list(identity)
      const checks = {}
      for (const [key, fn] of Object.entries({
        ids: () => service.parameter.listGeometryParameterIds(detached.id, identity),
        parm: () => service.parameter.getGeometryParameter(detached.id, detached.parms[0], identity),
        length: () => service.parameter.getFuselageLength(detached.id, identity),
        surfaces: () => service.parameter.listSurfaces(detached.id, identity),
        section: () => service.parameter.listCrossSectionParameterIds(detachedSection, identity),
        missing: () => service.parameter.listGeometryParameterIds('NOTREAL', identity),
      })) checks[key] = await failure(fn)
      const raw = {}
      for (const [key, fn] of Object.entries({
        ids: () => engine.testCall('geomParmIDs', detached.id),
        parm: () => engine.testCall('geomParm', detached.id, detached.parms[0]),
        length: () => engine.testCall('fuselageLength', detached.id),
        surfaces: () => engine.testCall('geomXSecs', detached.id),
        section: () => engine.testCall('xsecParmIDs', detachedSection),
        write: () => engine.testCall('geomSetParm', detached.id, detached.parms[0], 1),
      })) raw[key] = await failure(fn)
      await engine.testCall('parameterDetachedCleanup', detached.id)
      detached = undefined
      await engine.request('POST', '/file/new')
      const stale = await failure(() => service.parameter.listGeometryParameterIds(body, identity))
      return { body, child, detachedId: detachedFixtureId, originalLength, originalIds, childIds, emptySurfaces, tree, checks, raw, stale }
    } finally {
      if (detached) await engine.testCall('parameterDetachedCleanup', detached.id)
      service.close()
    }
  })
  assert.ok(result.originalIds.includes(result.originalLength.id))
  assert.ok(result.childIds.length)
  assert.deepEqual(result.emptySurfaces, [])
  assert.ok(!result.tree.geometries.some(g => g.id === result.detachedId))
  assert.ok(result.tree.geometries.some(g => g.id === result.body))
  assert.ok(result.tree.geometries.some(g => g.id === result.child))
  for (const [name, value] of Object.entries(result.checks)) assert.equal(value.code, 'ENGINE_ERROR', `${name}: ${JSON.stringify(value)}`)
  for (const [name, value] of Object.entries(result.raw)) assert.notEqual(value.code, 'SUCCEEDED', name)
  assert.equal(result.raw.write.outcome, 'not_written')
  assert.equal(result.raw.write.actual, null)
  assert.equal(result.stale.code, 'STALE_MODEL')
  assert.deepEqual(errors, [])
  console.log('PASS: detached geometry is rejected by parameter and XSec operations')
} finally { await browser.close() }
