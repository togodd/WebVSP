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
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const request = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  await page.evaluate(async () => { const m = await import('/src/modeling/index.ts'); window.testModeling = m.createBrowserModelingService() })
  const wing = (await request('POST', '/geoms', { type: 'WING' })).id
  const fuselage = (await request('POST', '/geoms', { type: 'FUSELAGE' })).id
  const surfaces = await request('GET', `/geoms/${wing}/xsecs`)
  const ids = await request('GET', `/geoms/${wing}/parms`)
  const facadeIds = await page.evaluate(wing => window.testModeling.parameter.listGeometryParameterIds(wing), wing)
  assert.deepEqual(facadeIds, ids)
  assert.equal((await page.evaluate(() => window.testModeling.capabilities())).features.find(x => x.name === 'parameter.read').status, 'supported')
  assert.ok(surfaces.length && surfaces[0].xsecs.length && ids.length)
  const parameter = await request('GET', `/geoms/${wing}/parms/${ids[0]}`)
  assert.equal(parameter.id, ids[0]); assert.equal(typeof parameter.value, 'number')
  const section = surfaces[0].xsecs[0]
  const sectionIds = await request('GET', `/xsecs/${section}/parms`)
  assert.ok(sectionIds.length)
  assert.equal((await request('GET', `/xsecs/${section}/parms/${sectionIds[0]}`)).id, sectionIds[0])
  let length
  for (const id of await request('GET', `/geoms/${fuselage}/parms`)) {
    const candidate = await request('GET', `/geoms/${fuselage}/parms/${id}`)
    if (candidate.name === 'Length' && candidate.group === 'Design' && candidate.active) { length = candidate; break }
  }
  assert.ok(length, 'Expected an active fuselage length parameter')
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
  const actual = await request('PUT', path, { value: 20 })
  assert.equal(actual.actual, 20)
  assert.equal((await request('GET', path)).value, 20)
  const failure = await page.evaluate(async ({path, value}) => {
    try { await window.__webvspEngine.request('PUT', path, {value}); return null }
    catch (error) { return {outcome: error.outcome, actual: error.actual} }
  }, {path, value: length.upperLimit + 1})
  assert.deepEqual(failure, {outcome: 'not_written', actual: 20})
  assert.equal((await request('GET', path)).value, 20)
  await assert.rejects(() => request('GET', `/geoms/${fuselage}/parms/${ids[0]}`))
  await assert.rejects(() => request('GET', '/xsecs/NOTREAL/parms'))
  await assert.rejects(() => request('GET', '/geoms/NOTREAL/parms'))
  await request('POST', '/geoms/delete', { ids: [wing] })
  await assert.rejects(() => request('GET', `/xsecs/${section}/parms`))
  assert.deepEqual(errors, [])
  console.log('PASS: geometry and cross-section parameter ownership, metadata and stale references')
} finally {
  await browser.close()
}
