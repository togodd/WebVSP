// Disposable Chromium + WASM; fake browser file picker, no user files.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const testPage = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
if (!['http:', 'https:'].includes(testPage.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testPage.hostname)) throw new Error('Test page must be loopback HTTP(S)')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort()
  })
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    let bytes = null
    window.__abaPicker = { saves: 0, opens: 0, byteLength: () => bytes?.byteLength ?? 0 }
    const file = { name: 'aba.vsp3', queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFile: async () => new File([bytes], 'aba.vsp3'), createWritable: async () => ({ write: async b => { bytes = new Uint8Array(b) }, close: async () => { window.__abaPicker.saves++ } }) }
    window.showSaveFilePicker = async () => file
    window.showOpenFilePicker = async () => { window.__abaPicker.opens++; return [file] }
  })
  await page.goto(testPage.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.evaluate(async () => { const m = await import('/src/modeling/index.ts'); window.__aba = m.createBrowserModelingService() })
  const info = () => page.evaluate(() => window.__aba.model.getInfo())
  const menu = async name => { await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click(); await page.locator('.menu-list').getByRole('button', { name, exact: true }).click() }
  const button = name => page.getByRole('button', { name, exact: true }).first()
  const waitCount = count => page.waitForFunction(count => window.__aba.model.getInfo().then(m => m.geometries.length === count), count, { timeout: 30000 })
  assert.equal((await info()).geometries.length, 0)
  await page.locator('select').filter({ has: page.locator('option:text-is("FUSELAGE")') }).first().selectOption({ label: 'FUSELAGE' })
  await button('Add').click()
  await waitCount(1)
  const before = await info()
  await menu('Save As...')
  await page.waitForFunction(() => window.__abaPicker.saves > 0, null, { timeout: 30000 })
  assert.ok(await page.evaluate(() => window.__abaPicker.byteLength()) > 0, 'fake handle must receive nonempty bytes')
  await button('Sel All').click()
  await page.waitForFunction(token => window.__aba.model.getSelection(token).then(s => s.geometryIds.length === 1), before.identity, { timeout: 30000 })
  await button('Delete').click()
  await waitCount(0)
  const deleted = await info()
  let absent = await page.evaluate(async ({id, token}) => { try { await window.__aba.geometry.get(id, token); return 'SUCCESS' } catch (e) { return e.code } }, {id: before.geometries[0].id, token: before.identity})
  await menu('Insert...')
  await page.waitForFunction(() => window.__abaPicker.opens > 0, { timeout: 30000 })
  await waitCount(1)
  const after = await info()
  const oldLookup = await page.evaluate(async ({id, token}) => { try { return { result: await window.__aba.geometry.get(id, token) } } catch (e) { return { code: e.code } } }, {id: before.geometries[0].id, token: before.identity})
  console.log(JSON.stringify({before, deleted, absent, after, oldLookup}, null, 2))
  assert.deepEqual(deleted.identity, before.identity)
  assert.equal(absent, 'GEOMETRY_NOT_FOUND')
  assert.deepEqual(after.identity, before.identity)
  assert.equal(after.geometries[0].id, before.geometries[0].id)
  assert.equal(oldLookup.result.geometry.id, before.geometries[0].id)
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__aba.close())
  console.log('PASS: old identity and geometry ID resolve after delete and insert')
} finally { await browser.close() }
