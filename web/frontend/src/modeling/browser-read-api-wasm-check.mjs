// Disposable headless browser only. Never attach to an existing user browser or open files.
// WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/browser-read-api-wasm-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const url = process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/'
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false })
try {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const initial = await page.evaluate(async () => {
    const entry = window.__webvspModelingReadV1
    if (!entry) throw new Error('Production entry not registered')
    const keys = Object.fromEntries(['model', 'geometry', 'parameter', 'wing', 'fuselage'].map(k => [k, Object.keys(entry[k]).sort()]))
    const info = await entry.model.getInfo()
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    try {
      return { info, serviceInfo: await service.model.getInfo(), list: await entry.geometry.list(info.identity), directList: await service.geometry.list(info.identity), keys, top: Object.keys(entry).sort() }
    } finally { service.close() }
  })
  assert.equal(initial.info.geometries.length, 0, 'refuse to alter a nonempty model')
  assert.deepEqual(initial.info, initial.serviceInfo)
  assert.deepEqual(initial.list, initial.directList)
  assert.deepEqual(initial.top, ['capabilities', 'declaredCapabilities', 'fuselage', 'geometry', 'model', 'parameter', 'protocol', 'wing'])
  assert.deepEqual(initial.keys, {
    model: ['getInfo', 'getSelection', 'getVisibleSurfaceBounds'], geometry: ['get', 'list', 'listTypes'],
    parameter: ['getCrossSectionParameter', 'getFuselageLength', 'getGeometryParameter', 'listCrossSectionParameterIds', 'listGeometryParameterIds', 'listSurfaces'],
    wing: ['get'], fuselage: ['get'],
  })
  const select = page.locator('select').filter({ has: page.locator('option:text-is("FUSELAGE")') }).first()
  await select.selectOption({ label: 'FUSELAGE' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForFunction(() => window.__webvspModelingReadV1.model.getInfo().then(info => info.geometries.length === 1), null, { timeout: 30000 })
  const populated = await page.evaluate(async () => {
    const api = window.__webvspModelingReadV1
    const info = await api.model.getInfo()
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    try { return { info, list: await api.geometry.list(info.identity), direct: await service.geometry.list(info.identity) } } finally { service.close() }
  })
  assert.deepEqual(populated.list, populated.direct)
  assert.deepEqual(populated.list.geometries ?? populated.list, populated.info.geometries)
  await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click()
  await page.waitForFunction(epoch => window.__webvspModelingReadV1.model.getInfo().then(info => info.identity.modelEpoch !== epoch), populated.info.identity.modelEpoch, { timeout: 30000 })
  const stale = await page.evaluate(async identity => {
    try { await window.__webvspModelingReadV1.geometry.list(identity); return 'SUCCEEDED' } catch (error) { return error.code }
  }, populated.info.identity)
  assert.equal(stale, 'STALE_MODEL')
  assert.deepEqual(errors, [])
  console.log('PASS: production registration, isolated WASM reads, whitelist and stale epoch')
} finally {
  await context.close()
  await browser.close()
}
