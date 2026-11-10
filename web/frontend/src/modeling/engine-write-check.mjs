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
  const data = await page.evaluate(async () => {
    const m = await import('/src/modeling/index.ts')
    const service = m.createBrowserModelingService()
    const engine = window.__webvspEngine
    const body = await engine.request('POST', '/geoms', { type: 'FUSELAGE' })
    const wing = await engine.request('POST', '/geoms', { type: 'WING', parent: body.id })
    const before = await engine.request('GET', `/geoms/${wing.id}/origin`)
    const moved = await engine.request('POST', '/geoms/move', { ids: [wing.id], delta: [2, 0, 0] })
    const origin = await engine.request('GET', `/geoms/${wing.id}/origin`)
    const model = await service.model.getInfo()
    const token = model.identity
    const fuselageView = await service.fuselage.get(body.id, token)
    const wingView = await service.wing.get(wing.id, token)
    const disabled = []
    for (const fn of [() => service.write.create({ type: 'WING', parentId: null }, token), () => service.write.move({ geometryId: wing.id, frame: 'world', units: 'model-native', delta: [1, 0, 0] }, token)]) {
      try { await fn(); disabled.push('SUCCEEDED') } catch (error) { disabled.push(error.code) }
    }
    const capabilities = service.capabilities()
    service.close()
    return { body, wing, before, moved, origin, model, fuselageView, wingView, disabled, capabilities }

  })
  assert.equal(data.model.geometries.length, 2)
  assert.equal(data.model.geometries.find(g => g.id === data.wing.id).parentId, data.body.id)
  assert.equal(data.moved.ok, true)
  assert.ok(Math.abs(data.origin[0] - data.before[0] - 2) < 1e-7)
  assert.deepEqual(data.disabled, ['UNSUPPORTED_OPERATION', 'UNSUPPORTED_OPERATION'])
  for (const name of ['geometry.create', 'geometry.move']) assert.equal(data.capabilities.features.find(c => c.name === name).status, 'unsupported')
  assert.equal(data.fuselageView.length.value, 30)
  assert.equal(data.fuselageView.surfaces[0].sections.length, 5)
  assert.equal(data.wingView.surfaces[0].stations[0].kind, 'rootAirfoilStation')
  assert.equal(data.wingView.surfaces[0].stations[1].kind, 'wingSection')
  assert.equal(data.capabilities.features.find(c => c.name === 'wing.read').status, 'supported')
  await page.waitForFunction(() => document.body.innerText.includes('WingGeom') && document.body.innerText.includes('FuselageGeom'))
  assert.deepEqual(errors, [])
  console.log('PASS: modeled create and world move readback, parent hierarchy and GUI tree')
} finally { await browser.close() }
