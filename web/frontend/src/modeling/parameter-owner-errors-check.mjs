// Requires a completed WASM build from this checkout and the isolated modeling test server.
// Run from web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/parameter-owner-errors-check.mjs
// This test replaces the model: use a disposable browser session and test server.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const deadline = setTimeout(() => { console.error('FAIL: parameter owner test timed out'); void browser.close() }, 180000)
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    const engine = window.__webvspEngine
    const failure = async fn => {
      try { await fn(); return { code: 'SUCCEEDED' } }
      catch (error) { return { name: error.name, code: error.code, message: error.message } }
    }
    try {
      await engine.request('POST', '/file/new')
      const body = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const other = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const token = (await service.model.getInfo()).identity
      const p = service.parameter
      const sections = (await p.listSurfaces(body, token)).flatMap(surface => surface.xsecs)
      const otherSections = (await p.listSurfaces(other, token)).flatMap(surface => surface.xsecs)
      if (!sections.length || !otherSections.length) throw new Error('Fixture requires two fuselage cross sections')
      const section = sections[0], otherSection = otherSections[0]
      const geomIds = await p.listGeometryParameterIds(body, token)
      const otherGeomIds = await p.listGeometryParameterIds(other, token)
      const sectionIds = await p.listCrossSectionParameterIds(section, token)
      const otherSectionIds = await p.listCrossSectionParameterIds(otherSection, token)
      if (!geomIds.length || !otherGeomIds.length || !sectionIds.length || !otherSectionIds.length) throw new Error('Fixture requires linkable parameters')
      const length = await p.getFuselageLength(body, token)
      const geometryParm = await p.getGeometryParameter(body, geomIds[0], token)
      const sectionParm = await p.getCrossSectionParameter(section, sectionIds[0], token)
      const shared = sectionIds.find(id => geomIds.includes(id))
      if (!shared) throw new Error('Expected a nested XSec parameter in the geometry linkable list')
      const nestedGeomParm = await p.getGeometryParameter(body, shared, token)
      const nestedSectionParm = await p.getCrossSectionParameter(section, shared, token)
      if (nestedGeomParm.id !== shared || nestedSectionParm.id !== shared || nestedGeomParm.container !== nestedSectionParm.container) throw new Error('Nested parameter membership disagrees')
      // A geometry's linkable list can include parameters of its nested XSecs.
      // Pick IDs proven absent from the target owner's list for negative tests.
      const sectionOnly = sectionIds.find(id => !geomIds.includes(id))
      const geometryOnly = geomIds.find(id => !sectionIds.includes(id))
      const missing = 'WEBVSP_MISSING_OWNER_ID'
      const badParm = 'WEBVSP_MISSING_PARM_ID'
      const cases = [
        ['surfaces', 'geomXSecs', missing, '', () => p.listSurfaces(missing, token), 'GEOMETRY_NOT_FOUND'],
        ['length', 'fuselageLength', missing, '', () => p.getFuselageLength(missing, token), 'GEOMETRY_NOT_FOUND'],
        ['geometryIds', 'geomParmIDs', missing, '', () => p.listGeometryParameterIds(missing, token), 'GEOMETRY_NOT_FOUND'],
        ['geometryParameter', 'geomParm', missing, geomIds[0], () => p.getGeometryParameter(missing, geomIds[0], token), 'GEOMETRY_NOT_FOUND'],
        ['sectionIds', 'xsecParmIDs', missing, '', () => p.listCrossSectionParameterIds(missing, token), 'CROSS_SECTION_NOT_FOUND'],
        ['sectionParameter', 'xsecParm', missing, sectionIds[0], () => p.getCrossSectionParameter(missing, sectionIds[0], token), 'CROSS_SECTION_NOT_FOUND'],
      ]
      const missingResults = []
      for (const [name, op, a, b, invoke, expected] of cases) {
        const facade = await failure(invoke)
        const guarded = await failure(() => engine.testCallGuarded(op, a, b, 0, token.modelEpoch))
        const legacy = await failure(() => engine.testCall(op, a, b, 0))
        missingResults.push({ name, expected, facade, guarded, legacy })
      }
      const invalidParameters = {}
      for (const [name, invoke] of Object.entries({
        missingGeometryParm: () => p.getGeometryParameter(body, badParm, token),
        otherGeometryParm: () => p.getGeometryParameter(body, otherGeomIds[0], token),
        ...(sectionOnly ? { sectionParmAsGeometry: () => p.getGeometryParameter(body, sectionOnly, token) } : {}),
        missingSectionParm: () => p.getCrossSectionParameter(section, badParm, token),
        otherSectionParm: () => p.getCrossSectionParameter(section, otherSectionIds[0], token),
        ...(geometryOnly ? { geometryParmAsSection: () => p.getCrossSectionParameter(section, geometryOnly, token) } : {}),
      })) invalidParameters[name] = await failure(invoke)
      // The unguarded bridge and the GUI's existing routes continue returning the
      // same successful values; missing-owner failures remain ordinary legacy errors.
      const legacySuccess = {
        surfaces: await engine.testCall('geomXSecs', body),
        length: await engine.testCall('fuselageLength', body),
        geometryIds: await engine.testCall('geomParmIDs', body),
        geometryParm: await engine.testCall('geomParm', body, geomIds[0]),
        sectionIds: await engine.testCall('xsecParmIDs', section),
        sectionParm: await engine.testCall('xsecParm', section, sectionIds[0]),
      }
      const routeSuccess = {
        surfaces: await engine.request('GET', `/geoms/${body}/xsecs`),
        length: await engine.request('GET', `/geoms/${body}/fuselage-length`),
        geometryIds: await engine.request('GET', `/geoms/${body}/parms`),
        geometryParm: await engine.request('GET', `/geoms/${body}/parms/${geomIds[0]}`),
        sectionIds: await engine.request('GET', `/xsecs/${section}/parms`),
        sectionParm: await engine.request('GET', `/xsecs/${section}/parms/${sectionIds[0]}`),
      }
      const baseline = { surfaces: await p.listSurfaces(body, token), length, geometryIds: geomIds, geometryParm, sectionIds, sectionParm }
      await engine.request('POST', '/file/new')
      const replacement = (await service.model.getInfo()).identity
      const stale = {}
      for (const [name, invoke] of Object.entries({
        surfaces: () => p.listSurfaces(body, token),
        length: () => p.getFuselageLength(body, token),
        geometryIds: () => p.listGeometryParameterIds(body, token),
        geometryParameter: () => p.getGeometryParameter(body, geomIds[0], token),
        sectionIds: () => p.listCrossSectionParameterIds(section, token),
        sectionParameter: () => p.getCrossSectionParameter(section, sectionIds[0], token),
      })) stale[name] = await failure(invoke)
      // With the replacement token the old owners are genuinely absent, not stale.
      const replaced = {}
      for (const [name, invoke] of Object.entries({
        surfaces: () => p.listSurfaces(body, replacement),
        length: () => p.getFuselageLength(body, replacement),
        geometryIds: () => p.listGeometryParameterIds(body, replacement),
        geometryParameter: () => p.getGeometryParameter(body, geomIds[0], replacement),
        sectionIds: () => p.listCrossSectionParameterIds(section, replacement),
        sectionParameter: () => p.getCrossSectionParameter(section, sectionIds[0], replacement),
      })) replaced[name] = await failure(invoke)
      return { token, replacement, missingResults, invalidParameters, baseline, legacySuccess, routeSuccess, stale, replaced }
    } finally { service.close() }
  })
  assert.equal(result.token.sessionId, result.replacement.sessionId)
  assert.notEqual(result.token.modelEpoch, result.replacement.modelEpoch)
  for (const { name, expected, facade, guarded, legacy } of result.missingResults) {
    assert.equal(facade.name, 'ModelingError', `${name}: ${JSON.stringify(facade)}`)
    assert.equal(facade.code, expected, name)
    assert.equal(guarded.code, expected, `${name}: guarded engine`)
    assert.notEqual(legacy.code, 'SUCCEEDED', `${name}: legacy must fail`)
    assert.equal(legacy.code, undefined, `${name}: legacy error stays unstructured`)
    assert.ok(legacy.message, `${name}: legacy error message`)
  }
  for (const [name, error] of Object.entries(result.invalidParameters)) assert.equal(error.code, 'ENGINE_ERROR', `${name}: ${JSON.stringify(error)}`)
  assert.deepEqual(result.legacySuccess, result.baseline)
  assert.deepEqual(result.routeSuccess, result.baseline)
  for (const [name, error] of Object.entries(result.stale)) assert.equal(error.code, 'STALE_MODEL', `${name}: ${JSON.stringify(error)}`)
  for (const [name, error] of Object.entries(result.replaced)) assert.equal(error.code, name.startsWith('section') ? 'CROSS_SECTION_NOT_FOUND' : 'GEOMETRY_NOT_FOUND', `${name}: ${JSON.stringify(error)}`)
  assert.deepEqual(pageErrors, [])
  console.log('PASS: guarded parameter owner errors, wrong-owner parameters, replacement and legacy compatibility')
} finally {
  clearTimeout(deadline)
  await browser.close()
}
