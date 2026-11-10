// Run against vite.modeling-test.config.ts with a matching WASM build.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM to a Chromium executable')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    window.testModeling = createBrowserModelingService()
  })
  const read = () => page.evaluate(() => window.testModeling.model.getInfo())
  const initial = await read()
  assert.equal(initial.geometries.length, 0)
  const select = page.locator('select').filter({ has: page.locator('option:text-is("FUSELAGE")') }).first()
  await select.selectOption({ label: 'FUSELAGE' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForFunction(() => window.testModeling.model.getInfo().then(x => x.geometries.length === 1))
  const first = await read()
  assert.equal(first.geometries[0].type, 'Fuselage')
  assert.deepEqual(first.selectedGeometryIds, [first.geometries[0].id])
  const bounds = await page.evaluate(() => window.testModeling.model.getVisibleSurfaceBounds())
  assert.ok(bounds.max[0] > bounds.min[0])
  await select.selectOption({ label: 'WING' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForFunction(() => window.testModeling.model.getInfo().then(x => x.geometries.length === 2))
  const second = await read()
  assert.equal(second.geometries[1].parentId, second.geometries[0].id)
  assert.equal(second.context.sessionId, initial.context.sessionId)
  assert.deepEqual(errors, [])
  console.log('PASS: UI creation, selection, bounds, hierarchy and engine-backed reads')
} finally {
  await browser.close()
}
