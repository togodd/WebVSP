// Requires the isolated modeling test server on 5179 and a matching WASM build.
// Run from web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-facade-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const s = createBrowserModelingService()
    const engine = window.__webvspEngine
    const fail = async (fn) => {
      try { await fn(); return { code: 'SUCCEEDED' } }
      catch (error) { return { code: error.code, details: error.details } }
    }
    try {
      await engine.request('POST', '/file/new')
      const first = await s.model.getInfo()
      await engine.request('POST', '/geoms', { type: 'WING' })
      await engine.request('POST', '/file/new')
      const replacement = await s.model.getInfo()
      const identity = replacement.identity
      const wing = (await engine.request('POST', '/geoms', { type: 'WING' })).id
      const body = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const surfaces = await s.parameter.listSurfaces(wing, identity)
      const section = surfaces[0].xsecs[0]
      const geomIds = await s.parameter.listGeometryParameterIds(body, identity)
      const sectionIds = await s.parameter.listCrossSectionParameterIds(section, identity)
      const length = await s.parameter.getFuselageLength(body, identity)
      const geomParameter = await s.parameter.getGeometryParameter(body, length.id, identity)
      const sectionParameter = await s.parameter.getCrossSectionParameter(section, sectionIds[0], identity)
      const invalidAsync = await s.geometry.get(wing, { sessionId: 'other', modelEpoch: '0' }).then(() => 'SUCCEEDED', e => e.code)
      const before = await s.model.getInfo()
      const originBefore = await engine.request('GET', `/geoms/${wing}/origin`)
      const input = { owner: 'geometry', ownerId: body, parameterId: length.id, value: length.value + 1 }
      const move = { geometryId: wing, frame: 'world', units: 'model-native', delta: [1, 0, 0] }
      // Use valid IDs belonging to the replacement model: a not-found error must not
      // mask a failure to propagate the old epoch to an individual engine request.
      const old = first.identity
      const stale = {}
      for (const [name, fn] of Object.entries({
        model: () => s.model.getInfo(old),
        geometry: () => s.geometry.get(wing, old),
        wing: () => s.wing.get(wing, old),
        fuselage: () => s.fuselage.get(body, old),
        surfaces: () => s.parameter.listSurfaces(wing, old),
        length: () => s.parameter.getFuselageLength(body, old),
        geometryIds: () => s.parameter.listGeometryParameterIds(body, old),
        sectionIds: () => s.parameter.listCrossSectionParameterIds(section, old),
        geometryParameter: () => s.parameter.getGeometryParameter(body, length.id, old),
        sectionParameter: () => s.parameter.getCrossSectionParameter(section, sectionIds[0], old),
      })) stale[name] = await fail(fn)
      // Writes are disabled pending protection against reentrant engine scripts.
      const disabledWrites = {}
      for (const [name, fn] of Object.entries({
        createOld: () => s.write.create({ type: 'WING', parentId: null }, old),
        createFresh: () => s.write.create({ type: 'WING', parentId: null }, identity),
        moveOld: () => s.write.move(move, old),
        moveFresh: () => s.write.move(move, identity),
        setOld: () => s.parameter.set(input, old),
        setFresh: () => s.parameter.set(input, identity),
      })) disabledWrites[name] = await fail(fn)
      const capabilities = s.capabilities()
      const after = await s.model.getInfo()
      const lengthAfter = await s.parameter.getFuselageLength(body, identity)
      const originAfter = await engine.request('GET', `/geoms/${wing}/origin`)
      const freshWing = await s.wing.get(wing, identity)
      const freshBody = await s.fuselage.get(body, identity)
      const finalModel = await s.model.getInfo(identity)
      return { first, replacement, before, after, length, lengthAfter, originBefore, originAfter, stale,
        wing, body, surfaces, geomIds, sectionIds, geomParameter, sectionParameter,
        freshWing, freshBody, disabledWrites, capabilities, finalModel, invalidAsync }
    } finally { s.close() }
  })
  assert.equal(result.invalidAsync, 'STALE_MODEL')
  assert.ok(result.first.identity.sessionId)
  assert.match(result.first.identity.modelEpoch, /^(0|[1-9]\d*)$/)
  assert.equal(result.first.identity.sessionId, result.replacement.identity.sessionId)
  assert.notEqual(result.first.identity.modelEpoch, result.replacement.identity.modelEpoch)
  assert.ok(result.surfaces.length && result.sectionIds.length && result.geomIds.length)
  assert.equal(result.geomParameter.id, result.length.id)
  assert.equal(result.sectionParameter.id, result.sectionIds[0])
  for (const [name, error] of Object.entries(result.stale)) assert.equal(error.code, 'STALE_MODEL', `${name}: ${JSON.stringify(error)}`)
  assert.deepEqual(result.after.geometries, result.before.geometries)
  assert.deepEqual(result.after.identity, result.before.identity)
  assert.deepEqual(result.lengthAfter, result.length)
  assert.deepEqual(result.originAfter, result.originBefore)
  assert.equal(result.freshWing.geometryId, result.wing)
  assert.equal(result.freshBody.geometry.id, result.body)
  for (const name of ['parameter.write', 'geometry.create', 'geometry.move']) {
    assert.equal(result.capabilities.features.find(c => c.name === name).status, 'unsupported', name)
  }
  for (const [name, error] of Object.entries(result.disabledWrites)) assert.equal(error.code, 'UNSUPPORTED_OPERATION', `${name}: ${JSON.stringify(error)}`)
  assert.deepEqual(result.finalModel.geometries, result.before.geometries)
  assert.deepEqual(errors, [])
  console.log('PASS: facade guards reject stale identities and fresh identities recover')
} finally { await browser.close() }
