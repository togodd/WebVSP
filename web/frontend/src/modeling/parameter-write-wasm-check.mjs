// Real WASM integration; a fresh browser context owns a disposable, isolated model.
// Run from web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/parameter-write-wasm-check.mjs
// The Vite test server at :5179 must proxy the production WASM build.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
let stage = 'browser startup'
const deadline = setTimeout(() => { console.error(`Timed out at: ${stage}`); void browser.close() }, 300000)
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  // Retain each asynchronous task in the page: never retry a dispatched write.
  let next = 0
  async function run(fn, arg) {
    const id = ++next
    await page.evaluate(({ id, source, arg }) => {
      const tasks = window.__writeIntegrationTasks ??= new Map()
      const task = { state: 'pending' }
      tasks.set(id, task)
      Promise.resolve().then(() => (0, eval)(`(${source})`)(arg)).then(
        value => Object.assign(task, { state: 'fulfilled', value }),
        error => Object.assign(task, { state: 'rejected', error: { message: error?.message, stack: error?.stack } }),
      )
    }, { id, source: fn.toString(), arg })
    try {
      const done = await page.waitForFunction(id => window.__writeIntegrationTasks?.get(id)?.state !== 'pending', id, { timeout: 60000, polling: 20 })
      await done.dispose()
      const result = await page.evaluate(id => window.__writeIntegrationTasks.get(id), id)
      if (result.state === 'rejected') throw new Error(result.error.stack || result.error.message)
      return result.value
    } finally { await page.evaluate(id => window.__writeIntegrationTasks?.delete(id), id).catch(() => {}) }
  }
  stage = 'create isolated fuselage and services'
  const setup = await run(async () => {
    const { createBrowserModelingService, createParameterWriteService } = await import('/src/modeling/index.ts')
    const engine = window.__webvspEngine
    if (typeof engine.testCallGuarded !== 'function') throw new Error('Vite dev-only guarded test hook unavailable')
    const facade = createBrowserModelingService()
    const geom = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
    const token = (await facade.model.getInfo()).identity
    const length = await facade.parameter.getFuselageLength(geom, token)
    const calls = []
    const writer = createParameterWriteService({ set(owner, ownerId, parameterId, value, identity) {
      calls.push({ owner, ownerId, parameterId, value, identity, sameIdentity: identity === token })
      return engine.testCallGuarded(owner === 'geometry' ? 'geomSetParm' : 'xsecSetParm', ownerId, parameterId, value, identity.modelEpoch)
    } })
    window.__writeIntegration = { engine, facade, writer, calls, geom, token, length }
    return { geom, token, length, feature: facade.capabilities().features.find(x => x.name === 'parameter.write') }
  })
  assert.equal(setup.feature.status, 'supported')
  assert.equal(setup.length.active, true)
  const target = setup.length.value === 20 ? 22 : 20
  assert.ok(target !== setup.length.value + 1 && target >= setup.length.lowerLimit && target <= setup.length.upperLimit)
  stage = 'facade write and readback'
  // A separate initial value preserves the isolated writer's change-to-target test.
  const facadeWrite = await run(async () => {
    const { facade, geom, token, length } = window.__writeIntegration
    const value = length.value + 1
    const result = await facade.parameter.set({ owner: 'geometry', ownerId: geom, parameterId: length.id, value }, token)
    return { value, result, after: (await facade.parameter.getFuselageLength(geom, token)).value }
  })
  assert.deepEqual(facadeWrite.result, { actual: facadeWrite.value })
  assert.equal(facadeWrite.after, facadeWrite.value)
  stage = 'guarded successful write and readback'
  const success = await run(async target => {
    const { writer, facade, geom, token, length, calls } = window.__writeIntegration
    const result = await writer.set({ owner: 'geometry', ownerId: geom, parameterId: length.id, value: target }, token)
    return { result, after: (await facade.parameter.getFuselageLength(geom, token)).value, call: calls[0], count: calls.length }
  }, target)
  assert.deepEqual(success.result, { actual: target })
  assert.equal(success.after, target)
  assert.equal(success.count, 1)
  assert.deepEqual(success.call.identity, setup.token)
  assert.equal(success.call.sameIdentity, false)
  assert.equal(success.call.owner, 'geometry')
  assert.equal(success.call.ownerId, setup.geom)
  assert.equal(success.call.parameterId, setup.length.id)
  stage = 'out-of-range write'
  const invalid = await run(async () => {
    const { writer, facade, geom, token, length, calls } = window.__writeIntegration
    try { await writer.set({ owner: 'geometry', ownerId: geom, parameterId: length.id, value: length.upperLimit + 1 }, token); return null }
    catch (e) { return { code: e.code, details: e.details, after: (await facade.parameter.getFuselageLength(geom, token)).value, count: calls.length } }
  })
  assert.deepEqual(invalid, { code: 'ENGINE_ERROR', details: { outcome: 'not_written', actual: target }, after: target, count: 2 })
  stage = 'replace disposable model and reject stale write'
  const stale = await run(async target => {
    const { engine, facade, writer, geom, token, length, calls } = window.__writeIntegration
    await engine.request('POST', '/file/new')
    const newGeom = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
    const current = (await facade.model.getInfo()).identity
    const before = (await facade.parameter.getFuselageLength(newGeom, current)).value
    try { await writer.set({ owner: 'geometry', ownerId: geom, parameterId: length.id, value: target }, token); return null }
    catch (e) { return { code: e.code, details: e.details, before, after: (await facade.parameter.getFuselageLength(newGeom, current)).value, oldEpoch: token.modelEpoch, newEpoch: current.modelEpoch, count: calls.length } }
  }, target)
  assert.notEqual(stale.oldEpoch, stale.newEpoch)
  assert.equal(stale.code, 'STALE_MODEL')
  assert.deepEqual(stale.details, { outcome: 'not_written', actual: null })
  assert.equal(stale.after, stale.before)
  assert.equal(stale.count, 3)
  assert.deepEqual(errors, [])
  await run(() => window.__writeIntegration.facade.close())
  console.log(`PASS: production WASM guarded parameter service: copied identity, ${setup.length.value} -> ${target} readback, out-of-range and stale not_written, facade write verified`)
} finally {
  clearTimeout(deadline)
  await browser.close()
}
