import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const data = await page.evaluate(async () => {
    const m = await import('/src/modeling/index.ts')
    const service = m.createBrowserModelingService()
    const body = await service.write.create({ type: 'FUSELAGE', parentId: null })
    const wing = await service.write.create({ type: 'WING', parentId: body.geometryId })
    const moved = await service.write.move({ geometryId: wing.geometryId, frame: 'world', units: 'model-native', delta: [2, 0, 0] })
    const model = await service.model.getInfo()
    return { body, wing, moved, model }
  })
  assert.equal(data.model.geometries.length, 2)
  assert.equal(data.model.geometries.find(g => g.id === data.wing.geometryId).parentId, data.body.geometryId)
  assert.ok(Number.isFinite(data.moved.origin[0]))
  await page.waitForFunction(() => document.body.innerText.includes('WingGeom') && document.body.innerText.includes('FuselageGeom'))
  assert.deepEqual(errors, [])
  console.log('PASS: modeled create and world move readback, parent hierarchy and GUI tree')
} finally { await browser.close() }
