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
      const model = await engine.testCall('model')
      if (!model.modelEpochValid) throw new Error('Invalid model epoch')
      const guarded = (op, a = '', b = '') => engine.testCallGuarded(op, a, b, 0, model.modelEpoch)
      // Exercise the exported guarded entry point directly against a real detached
      // store member, not just the facade's own parent validation.
      const addFailures = []
      for (const parent of [detached.id, 'NOTREAL']) {
        const before = await engine.testCall('model')
        const error = await failure(() => guarded('addGeom', 'WING', parent))
        const after = await engine.testCall('model')
        addFailures.push({ parent, before: { geoms: before.geoms, active: before.active }, error, after: { geoms: after.geoms, active: after.active } })
      }
      const addedChild = await guarded('addGeom', 'WING', body)
      const addedRoot = await guarded('addGeom', 'BLANK', '')
      const addedNone = await guarded('addGeom', 'BLANK', 'NONE')
      const addedVehicle = await guarded('addGeom', 'BLANK', model.vehicleId)
      const legacyNone = await engine.testCall('addGeom', 'BLANK', 'NONE')
      const legacyVehicle = await engine.testCall('addGeom', 'BLANK', model.vehicleId)
      const afterAdds = await engine.testCall('model')
      const origin = () => engine.testCall('origin', body)
      const moveFailures = []
      for (const ids of [detached.id, `${body},${detached.id}`, `${detached.id},${body}`, 'NOTREAL', `${body},NOTREAL`, '', `,${body}`, `${body},`, `${body},,${child}`]) {
        const before = await origin()
        const error = await failure(() => guarded('move', ids, '1,2,3'))
        moveFailures.push({ ids, before, error, after: await origin() })
      }
      const beforeMove = await origin()
      const moved = await guarded('move', body, '1,2,3')
      const afterMove = await origin()
      const legacy = await engine.testCall('move', body, ' 2junk,1')
      const afterLegacy = await origin()
      await engine.testCall('parameterDetachedCleanup', detached.id)
      detached = undefined
      await engine.request('POST', '/file/new')
      const stale = await failure(() => service.parameter.listGeometryParameterIds(body, identity))
      return { body, child, detachedId: detachedFixtureId, originalLength, originalIds, childIds, emptySurfaces, tree, checks, raw, stale, addFailures, addedChild, addedRoot, addedNone, addedVehicle, legacyNone, legacyVehicle, afterAdds, moveFailures, beforeMove, moved, afterMove, legacy, afterLegacy }
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
  for (const [name, value] of Object.entries(result.checks)) assert.equal(value.code, name === 'section' ? 'CROSS_SECTION_NOT_FOUND' : 'GEOMETRY_NOT_FOUND', `${name}: ${JSON.stringify(value)}`)
  for (const [name, value] of Object.entries(result.raw)) assert.notEqual(value.code, 'SUCCEEDED', name)
  assert.equal(result.raw.write.outcome, 'not_written')
  assert.equal(result.raw.write.actual, null)
  for (const { parent, before, error, after } of result.addFailures) {
    assert.notEqual(error.code, 'SUCCEEDED', parent)
    assert.equal(error.outcome, 'not_written', parent)
    assert.equal(error.actual, null, parent)
    assert.deepEqual(after, before, parent)
  }
  const added = result.afterAdds.geoms
  assert.equal(added.find(g => g.id === result.addedChild.id)?.parent, result.body)
  for (const root of [result.addedRoot, result.addedNone, result.addedVehicle, result.legacyNone, result.legacyVehicle]) {
    assert.ok(root.id)
    assert.equal(added.find(g => g.id === root.id)?.parent, null)
  }
  for (const { ids, before, error, after } of result.moveFailures) {
    assert.notEqual(error.code, 'SUCCEEDED', ids)
    assert.equal(error.outcome, 'not_written', ids)
    assert.equal(error.actual, null, ids)
    assert.deepEqual(after, before, ids)
  }
  assert.equal(result.moved.ok, true)
  assert.equal(result.legacy.ok, true)
  for (const [i, delta] of [1, 2, 3].entries())
    assert.ok(Math.abs(result.afterMove[i] - result.beforeMove[i] - delta) < 1e-8)
  for (const [i, delta] of [2, 1, 0].entries())
    assert.ok(Math.abs(result.afterLegacy[i] - result.afterMove[i] - delta) < 1e-8)
  assert.equal(result.stale.code, 'STALE_MODEL')
  assert.deepEqual(errors, [])
  console.log('PASS: detached geometry is rejected by guarded add, move, parameter and XSec operations')
} finally { await browser.close() }
