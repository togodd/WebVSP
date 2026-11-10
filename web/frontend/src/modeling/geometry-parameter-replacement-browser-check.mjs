// Browser integration check: isolated test server :5179 with matching WASM.
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/geometry-parameter-replacement-browser-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const before = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    window.__parameterReplacementService = service
    const geometryId = (await window.__webvspEngine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
    const identity = (await service.model.getInfo()).identity
    const ids = await service.parameter.listGeometryParameterIds(geometryId, identity)
    const parameter = await service.parameter.getGeometryParameter(geometryId, ids[0], identity)
    return { geometryId, identity, ids, parameter }
  })
  assert.ok(before.ids.length)
  assert.equal(before.parameter.id, before.ids[0])
  assert.equal(typeof before.parameter.value, 'number')

  // Replace through OpenVSP's mirrored GUI, not the /file/new API.
  await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click()
  await page.waitForFunction(epoch => window.__webvspEngine.testCall('model').then(m => m.modelEpochValid && m.modelEpoch !== epoch), before.identity.modelEpoch, { timeout: 30000 })

  const after = await page.evaluate(async old => {
    const service = window.__parameterReplacementService
    const identity = (await service.model.getInfo()).identity
    const geometryId = (await window.__webvspEngine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
    const ids = await service.parameter.listGeometryParameterIds(geometryId, identity)
    const parameter = await service.parameter.getGeometryParameter(geometryId, ids[0], identity)
    const failure = async fn => {
      try { await fn(); return 'SUCCEEDED' } catch (error) { return error.code }
    }
    // Test both old handles and valid new handles: stale identity must take
    // precedence over not-found and must not work even for existing objects.
    const stale = {
      oldList: await failure(() => service.parameter.listGeometryParameterIds(old.geometryId, old.identity)),
      oldGet: await failure(() => service.parameter.getGeometryParameter(old.geometryId, old.ids[0], old.identity)),
      newList: await failure(() => service.parameter.listGeometryParameterIds(geometryId, old.identity)),
      newGet: await failure(() => service.parameter.getGeometryParameter(geometryId, ids[0], old.identity)),
    }
    const recoveredIds = await service.parameter.listGeometryParameterIds(geometryId, identity)
    const recoveredParameter = await service.parameter.getGeometryParameter(geometryId, ids[0], identity)
    service.close()
    return { identity, geometryId, ids, parameter, stale, recoveredIds, recoveredParameter }
  }, before)
  assert.equal(after.identity.sessionId, before.identity.sessionId)
  assert.notEqual(after.identity.modelEpoch, before.identity.modelEpoch)
  assert.notEqual(after.geometryId, before.geometryId)
  assert.ok(after.ids.length)
  assert.equal(after.parameter.id, after.ids[0])
  assert.equal(typeof after.parameter.value, 'number')
  assert.deepEqual(after.stale, { oldList: 'STALE_MODEL', oldGet: 'STALE_MODEL', newList: 'STALE_MODEL', newGet: 'STALE_MODEL' })
  assert.deepEqual(after.recoveredIds, after.ids)
  assert.deepEqual(after.recoveredParameter, after.parameter)
  assert.deepEqual(errors, [])
  console.log(`PASS: GUI New epoch ${before.identity.modelEpoch} -> ${after.identity.modelEpoch}; stale geometry parameter get/list rejected; fresh get/list recovered`)
} finally { await browser.close() }
