// Requires vite.modeling-test.config.ts backed by a WASM build from the same checkout.
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
  const request = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  await page.evaluate(async () => { const m = await import('/src/modeling/index.ts'); window.testModeling = m.createBrowserModelingService() })
  const wing = (await request('POST', '/geoms', { type: 'WING' })).id
  const pod = (await request('POST', '/geoms', { type: 'POD' })).id
  const clone = (await request('POST', '/geoms', { type: 'CLONE' })).id
  const fuselage = (await request('POST', '/geoms', { type: 'FUSELAGE' })).id
  const surfaces = await request('GET', `/geoms/${wing}/xsecs`)
  const ids = await request('GET', `/geoms/${wing}/parms`)
  const token = await page.evaluate(async () => (await window.testModeling.model.getInfo()).identity)
  const facadeIds = await page.evaluate(({ wing, token }) => window.testModeling.parameter.listGeometryParameterIds(wing, token), { wing, token })
  assert.deepEqual(facadeIds, ids)
  const capabilities = (await page.evaluate(() => window.testModeling.capabilities())).features
  assert.equal(capabilities.find(x => x.name === 'parameter.read').status, 'supported')
  assert.equal(capabilities.find(x => x.name === 'parameter.write').status, 'unsupported')
  assert.ok(surfaces.length && surfaces[0].xsecs.length && ids.length)
  const parameter = await request('GET', `/geoms/${wing}/parms/${ids[0]}`)
  assert.equal(parameter.id, ids[0]); assert.equal(typeof parameter.value, 'number')
  const section = surfaces[0].xsecs[0]
  const sectionIds = await request('GET', `/xsecs/${section}/parms`)
  assert.ok(sectionIds.length)
  assert.equal((await request('GET', `/xsecs/${section}/parms/${sectionIds[0]}`)).id, sectionIds[0])
  const lengths = []
  for (const id of await request('GET', `/geoms/${fuselage}/parms`)) {
    const candidate = await request('GET', `/geoms/${fuselage}/parms/${id}`)
    if (candidate.name === 'Length' && candidate.group === 'Design' && candidate.container === fuselage) lengths.push(candidate)
  }
  assert.equal(lengths.length, 1, 'Expected exactly one top-level fuselage Design/Length parameter')
  const length = lengths[0]
  assert.ok(length.active, 'Expected an active fuselage length parameter')
  assert.deepEqual(await request('GET', `/geoms/${fuselage}/fuselage-length`), length)
  // A POD also has a top-level Design/Length: matching metadata is not a type check.
  const podParms = await request('GET', `/geoms/${pod}/parms`)
  const podMetadata = await Promise.all(podParms.map(id => request('GET', `/geoms/${pod}/parms/${id}`)))
  assert.ok(podMetadata.some(p => p.name === 'Length' && p.group === 'Design' && p.container === pod))
  for (const geom of [pod, wing, clone]) {
    await assert.rejects(() => request('GET', `/geoms/${geom}/fuselage-length`), /not a fuselage/i)
  }
  await assert.rejects(() => request('GET', '/geoms/NOTREAL/fuselage-length'), /not found in the current model/i)
  let tess
  for (const id of await request('GET', `/geoms/${fuselage}/parms`)) {
    const candidate = await request('GET', `/geoms/${fuselage}/parms/${id}`)
    if (candidate.name === 'Tess_W' && candidate.group === 'Shape') { tess = candidate; break }
  }
  assert.ok(tess?.active && tess.value === 17)
  const tessPath = `/geoms/${fuselage}/parms/${tess.id}`
  const quantized = await page.evaluate(async path => {
    try { await window.__webvspEngine.request('PUT', path, {value: 18}); return null }
    catch (error) { return {outcome: error.outcome, actual: error.actual} }
  }, tessPath)
  assert.deepEqual(quantized, {outcome: 'not_written', actual: 17})
  assert.equal((await request('GET', tessPath)).value, 17)
  const path = `/geoms/${fuselage}/parms/${length.id}`
  const input = { owner: 'geometry', ownerId: fuselage, parameterId: length.id, value: 20 }
  const disabled = await page.evaluate(async ({ input, token }) => {
    try { await window.testModeling.parameter.set(input, token); return null }
    catch (error) { return error.code }
  }, { input, token })
  assert.equal(disabled, 'UNSUPPORTED_OPERATION')
  assert.equal((await request('GET', path)).value, length.value)
  const actual = await request('PUT', path, { value: 20 })
  assert.equal(actual.actual, 20)
  assert.equal((await request('GET', path)).value, 20)
  const failure = await page.evaluate(async ({ path, value }) => {
    try { await window.__webvspEngine.request('PUT', path, { value }); return null }
    catch (error) { return {outcome: error.outcome, actual: error.actual} }
  }, { path, value: length.upperLimit + 1 })
  assert.deepEqual(failure, {outcome: 'not_written', actual: 20})
  assert.equal((await request('GET', path)).value, 20)
  const race = await page.evaluate(async ({ input, path }) => {
    const { createParameterWriteService } = await import('/src/modeling/index.ts')
    const controller = new AbortController()
    let dispatched = false
    let finish
    const done = new Promise(resolve => { finish = resolve })
    const service = createParameterWriteService({
      set: async (_owner, _ownerId, _parameterId, value) => {
        dispatched = true
        try { return await window.__webvspEngine.request('PUT', path, { value }) }
        finally { finish() }
      },
    }, controller.signal)
    const pending = service.set({ ...input, value: 21 })
    controller.abort()
    let outcome
    try { await pending; outcome = null } catch (error) { outcome = error.code }
    await done
    let closed
    try { await service.set(input); closed = null } catch (error) { closed = error.code }
    return { dispatched, outcome, closed }
  }, { input, path })
  assert.deepEqual(race, { dispatched: true, outcome: 'OUTCOME_UNKNOWN', closed: 'SESSION_CLOSED' })
  // The dispatched engine request still runs; close cannot cancel it.
  assert.equal((await request('GET', path)).value, 21)
  await page.evaluate(() => window.testModeling.close())
  await assert.rejects(() => request('GET', `/geoms/${fuselage}/parms/${ids[0]}`))
  await assert.rejects(() => request('GET', '/xsecs/NOTREAL/parms'))
  await assert.rejects(() => request('GET', '/geoms/NOTREAL/parms'))
  await request('POST', '/geoms/delete', { ids: [wing, fuselage] })
  await assert.rejects(() => request('GET', `/xsecs/${section}/parms`))
  await assert.rejects(() => request('GET', `/geoms/${fuselage}/fuselage-length`), /not found in the current model/i)
  assert.deepEqual(errors, [])
  console.log('PASS: geometry and cross-section parameter ownership, metadata and stale references')
} finally {
  await browser.close()
}
