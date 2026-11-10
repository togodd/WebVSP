// Real mirrored GUI selection and New; use an isolated modeling test server with matching WASM.
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/selection-browser-check.mjs
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
  await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    window.__selectionService = createBrowserModelingService()
  })
  const info = () => page.evaluate(() => window.__selectionService.model.getInfo())
  const initial = await info()
  assert.equal(initial.geometries.length, 0, 'expected isolated empty model')
  const select = page.locator('select').filter({ has: page.locator('option:text-is("FUSELAGE")') }).first()
  const add = async type => {
    await select.selectOption({ label: type })
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  }
  await add('FUSELAGE')
  await page.waitForFunction(() => window.__selectionService.model.getInfo().then(m => m.geometries.length === 1))
  const first = await info()
  const identity = first.identity
  const assertSelection = async expected => {
    await page.waitForFunction(({ identity, expected }) => window.__selectionService.model.getSelection(identity)
      .then(s => s.geometryIds.length === expected.length && expected.every(id => s.geometryIds.includes(id))), { identity, expected }, { timeout: 30000 })
    const { selection, model } = await page.evaluate(async identity => ({
      selection: await window.__selectionService.model.getSelection(identity),
      model: await window.__selectionService.model.getInfo(identity),
    }), identity)
    assert.deepEqual([...selection.geometryIds].sort(), [...expected].sort())
    assert.deepEqual([...selection.geometryIds].sort(), [...model.selectedGeometryIds].sort())
    assert.equal(selection.context.sessionId, identity.sessionId)
  }
  await assertSelection([first.geometries[0].id])
  await add('WING')
  await page.waitForFunction(() => window.__selectionService.model.getInfo().then(m => m.geometries.length === 2))
  const both = await info()
  const wing = both.geometries.find(g => g.type.toUpperCase() === 'WING')
  assert.ok(wing)
  await assertSelection([wing.id])
  await page.getByRole('button', { name: 'Sel All', exact: true }).first().click()
  await assertSelection(both.geometries.map(g => g.id))
  // Alt+A is the application's real keyboard deselect command.
  await page.keyboard.press('Alt+a')
  await assertSelection([])
  await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click()
  await page.waitForFunction(epoch => window.__selectionService.model.getInfo().then(m => m.identity.modelEpoch !== epoch), identity.modelEpoch, { timeout: 30000 })
  const result = await page.evaluate(async identity => {
    const service = window.__selectionService
    let stale
    try { await service.model.getSelection(identity); stale = 'SUCCEEDED' } catch (error) { stale = error.code }
    const fresh = await service.model.getInfo()
    return { stale, fresh, selection: await service.model.getSelection(fresh.identity) }
  }, identity)
  assert.equal(result.stale, 'STALE_MODEL')
  assert.equal(result.fresh.identity.sessionId, identity.sessionId)
  assert.deepEqual(result.selection.geometryIds, [])
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__selectionService.close())
  console.log('PASS: GUI add/select all/deselect and New; getSelection current and stale identities')
} finally { await browser.close() }
