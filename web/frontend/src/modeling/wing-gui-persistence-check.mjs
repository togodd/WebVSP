// Run against vite.modeling-test.config.ts with a matching WASM build.
// A fresh browser context and fake in-memory picker keep this model isolated from user files.
// GUI edits exercise the real mirrored OpenVSP widgets, not the modeling facade's write API.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const testPage = process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM to a Chromium executable')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
try {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    let bytes = null
    window.__wingTestPicker = { saves: 0, opens: 0, size: 0 }
    const handle = {
      name: 'wing-domain-test.vsp3',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFile: async () => {
        if (!bytes) throw new Error('No model has been saved')
        return new File([bytes], 'wing-domain-test.vsp3')
      },
      createWritable: async () => ({
        write: async data => { bytes = new Uint8Array(data) },
        close: async () => { window.__wingTestPicker.saves++; window.__wingTestPicker.size = bytes.length },
      }),
    }
    window.showSaveFilePicker = async () => handle
    window.showOpenFilePicker = async () => { window.__wingTestPicker.opens++; return [handle] }
  })
  await page.goto(testPage)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    window.__wingTestService = createBrowserModelingService()
  })
  const info = () => page.evaluate(() => window.__wingTestService.model.getInfo())
  const views = (wingId, fuselageId, identity) => page.evaluate(async ({ wingId, fuselageId, identity }) => {
    const s = window.__wingTestService
    return {
      wing: await s.wing.get(wingId, identity),
      raw: await s.parameter.listSurfaces(wingId, identity),
      fuselage: await s.fuselage.get(fuselageId, identity),
    }
  }, { wingId, fuselageId, identity })
  const checkViews = ({ wing, raw, fuselage }) => {
    assert.equal(wing.surfaces.length, 1)
    assert.equal(raw.length, 1)
    const stations = wing.surfaces[0].stations
    assert.deepEqual(stations.map(s => s.id), raw[0].xsecs)
    assert.equal(wing.surfaces[0].id, raw[0].id)
    assert.deepEqual(stations.map(s => s.index), stations.map((_, i) => i))
    assert.deepEqual(stations.map(s => s.kind), stations.map((_, i) => i === 0 ? 'rootAirfoilStation' : 'wingSection'))
    assert.equal(new Set(stations.map(s => s.id)).size, stations.length)
    assert.equal(fuselage.geometry.type.toUpperCase(), 'FUSELAGE')
    assert.equal(fuselage.length.name, 'Length')
    assert.equal(fuselage.length.group, 'Design')
    assert.ok(fuselage.surfaces.length > 0)
    for (const surface of fuselage.surfaces) {
      assert.deepEqual(surface.sections.map(s => s.index), surface.sections.map((_, i) => i))
      assert.ok(surface.sections.every(s => s.shape === null))
    }
  }
  const menu = async name => {
    await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
    await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
  }

  assert.equal((await info()).geometries.length, 0, 'expected a fresh isolated model')
  const select = page.locator('select').filter({ has: page.locator('option:text-is("FUSELAGE")') }).first()
  await select.selectOption({ label: 'FUSELAGE' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForFunction(() => window.__wingTestService.model.getInfo().then(m => m.geometries.length === 1))
  await select.selectOption({ label: 'WING' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForFunction(() => window.__wingTestService.model.getInfo().then(m => m.geometries.length === 2))
  const initial = await info()
  const fuselage = initial.geometries.find(g => g.type.toUpperCase() === 'FUSELAGE')
  const wing = initial.geometries.find(g => g.type.toUpperCase() === 'WING')
  assert.ok(fuselage && wing)
  assert.equal(wing.parentId, fuselage.id)
  const before = await views(wing.id, fuselage.id, initial.identity)
  checkViews(before)
  const oldIds = before.wing.surfaces[0].stations.map(s => s.id)
  assert.ok(oldIds.length >= 2)

  // Change an absolute world coordinate using the mirrored GUI, not facade writes.
  // The two XLoc fields are relative and absolute; target the actual bound parm.
  const targetX = 12.375
  const absButton = page.getByRole('button', { name: 'Abs', exact: true })
  const xAbs = page.locator('.m-w.m-input[title*="XForm:X_Location"] input')
  const origin = id => page.evaluate(id => window.__webvspEngine.request('GET', `/geoms/${encodeURIComponent(id)}/origin`), id)
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`)
  const showXForm = async () => {
    await page.locator('.m-tabbar').getByRole('button', { name: 'XForm', exact: true }).click()
    await absButton.waitFor({ state: 'visible' })
    await xAbs.waitFor({ state: 'visible' })
  }
  const waitForX = async (id, x) => {
    await page.waitForFunction(async ({ id, x }) => {
      const origin = await window.__webvspEngine.request('GET', `/geoms/${encodeURIComponent(id)}/origin`)
      const input = document.querySelector('.m-w.m-input[title*="XForm:X_Location"] input')
      return Math.abs(origin[0] - x) < 1e-6 && input && Math.abs(Number(input.value) - x) < 1e-6
    }, { id, x }, { timeout: 30000 })
  }
  await showXForm()
  await absButton.click()
  await page.waitForFunction(() => [...document.querySelectorAll('.m-w button')].some(button => button.textContent.trim() === 'Abs' && button.classList.contains('on')), null, { timeout: 30000 })
  const originBefore = await origin(wing.id)
  await xAbs.fill(String(targetX))
  await xAbs.press('Enter')
  await waitForX(wing.id, targetX)
  const changedOrigin = await origin(wing.id)
  near(changedOrigin[0], targetX, 'GUI absolute XLoc must set the engine world origin')
  near(changedOrigin[1], originBefore[1], 'GUI XLoc must preserve world Y')
  near(changedOrigin[2], originBefore[2], 'GUI XLoc must preserve world Z')
  assert.ok(Math.abs(originBefore[0] - targetX) > 1e-6, 'XLoc edit must change the origin')
  near(Number(await xAbs.inputValue()), targetX, 'GUI absolute XLoc readback')

  // A freshly created WingGeom initializes its active Wing Section to 1. Insert
  // is after that section, i.e. at XSec index 2 (not a new root station).
  await page.locator('.m-tabbar').getByRole('button', { name: 'Sect', exact: true }).click()
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await page.waitForFunction(({ id, identity, count }) => window.__wingTestService.wing.get(id, identity)
    .then(v => v.surfaces[0]?.stations.length === count),
  { id: wing.id, identity: initial.identity, count: oldIds.length + 1 }, { timeout: 30000 })
  const after = await views(wing.id, fuselage.id, initial.identity)
  checkViews(after)
  const newIds = after.wing.surfaces[0].stations.map(s => s.id)
  assert.equal(newIds.length, oldIds.length + 1)
  assert.ok(!oldIds.includes(newIds[2]))
  assert.deepEqual([...newIds.slice(0, 2), ...newIds.slice(3)], oldIds)

  await menu('Save As...')
  await page.waitForFunction(() => window.__wingTestPicker.saves > 0 && window.__wingTestPicker.size > 0, null, { timeout: 30000 })
  await page.evaluate(() => window.__webvspEngine.request('POST', '/file/new'))
  const empty = await info()
  assert.equal(empty.geometries.length, 0)
  await menu('Open...')
  await page.waitForFunction(() => window.__wingTestPicker.opens > 0, null, { timeout: 30000 })
  await page.waitForFunction(() => window.__wingTestService.model.getInfo().then(m => m.geometries.length === 2), null, { timeout: 30000 })
  const reopened = await info()
  const reopenedWing = reopened.geometries.find(g => g.type.toUpperCase() === 'WING')
  const reopenedFuselage = reopened.geometries.find(g => g.type.toUpperCase() === 'FUSELAGE')
  assert.ok(reopenedWing && reopenedFuselage)
  assert.equal(reopenedWing.parentId, reopenedFuselage.id)
  const restored = await views(reopenedWing.id, reopenedFuselage.id, reopened.identity)
  checkViews(restored)
  assert.equal(restored.wing.surfaces[0].stations.length, newIds.length)
  assert.deepEqual(restored.wing.surfaces[0].stations.map(s => [s.index, s.kind]), after.wing.surfaces[0].stations.map(s => [s.index, s.kind]))
  assert.equal(restored.fuselage.length.value, after.fuselage.length.value)
  assert.deepEqual(restored.fuselage.surfaces.map(s => s.sections.length), after.fuselage.surfaces.map(s => s.sections.length))
  const reopenedOrigin = await origin(reopenedWing.id)
  for (let i = 0; i < 3; i++) near(reopenedOrigin[i], changedOrigin[i], `saved world origin component ${i}`)
  // Re-select the reopened wing to inspect its own editor, rather than assuming
  // that opening a file restores the previous selection.
  await page.evaluate(id => window.__webvspEngine.request('POST', '/pick', { id }), reopenedWing.id)
  await showXForm()
  await waitForX(reopenedWing.id, targetX)
  near(Number(await xAbs.inputValue()), targetX, 'reopened GUI absolute XLoc')
  assert.ok(await absButton.evaluate(el => el.classList.contains('on')), 'reopened XForm must retain Abs mode')
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__wingTestService.close())
  console.log('PASS: GUI wing XForm Abs XLoc and Insert survive fake-picker save/reopen; GUI edits are not facade writes')
} finally {
  await context.close()
  await browser.close()
}
