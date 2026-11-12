// Disposable Chromium + WASM; in-memory fake pickers, no user files.
// This checks observable IDs and bytes only, not object instances or disk persistence.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const testPage = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
if (!['http:', 'https:'].includes(testPage.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testPage.hostname)) throw new Error('Test page must be loopback HTTP(S)')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  const downloads = []
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort()
  })
  page.on('download', download => { downloads.push(download.url()); void download.cancel() })
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    let bytes = null
    window.__abaPicker = { saves: 0, opens: 0, reads: [], saved: () => bytes && Array.from(bytes) }
    const file = {
      name: 'aba.vsp3', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      getFile: async () => {
        if (!bytes) throw new Error('Fake file read before save')
        const result = new File([bytes], 'aba.vsp3')
        window.__abaPicker.reads.push(Array.from(new Uint8Array(await result.arrayBuffer())))
        return result
      },
      createWritable: async () => ({ write: async b => { bytes = new Uint8Array(b).slice() }, close: async () => { window.__abaPicker.saves++ } }),
    }
    window.showSaveFilePicker = async () => file
    window.showOpenFilePicker = async () => { window.__abaPicker.opens++; return [file] }
    window.showDirectoryPicker = async () => { throw new Error('Unexpected directory picker') }
    // Prevent fallback anchor downloads even if a picker path regresses.
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute('download')) throw new Error('Unexpected download')
      return click.call(this)
    }
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
  assert.match(before.geometries[0].type, /^fuselage$/i)
  assert.ok(before.geometries[0].id)
  await menu('Save As...')
  await page.waitForFunction(() => window.__abaPicker.saves > 0, null, { timeout: 30000 })
  const saved = await page.evaluate(() => window.__abaPicker.saved())
  assert.ok(saved?.length, 'fake handle must receive nonempty bytes')
  const xml = await page.evaluate(bytes => {
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)), 'application/xml')
    return { root: doc.documentElement.tagName, errors: doc.querySelectorAll('parsererror').length,
      geometries: Array.from(doc.querySelectorAll('Geom')).filter(geom => geom.querySelector(':scope > GeomBase')).map(geom => ({
        id: geom.querySelector(':scope > ParmContainer > ID')?.textContent,
        type: geom.querySelector(':scope > GeomBase > TypeName')?.textContent,
      })) }
  }, saved)
  assert.equal(xml.errors, 0, 'saved bytes must parse as XML')
  assert.equal(xml.root, 'Vsp_Geometry')
  assert.deepEqual(xml.geometries, [{ id: before.geometries[0].id, type: before.geometries[0].type }], 'saved XML must contain exactly the expected geometry')
  await button('Sel All').click()
  await page.waitForFunction(token => window.__aba.model.getSelection(token).then(s => s.geometryIds.length === 1), before.identity, { timeout: 30000 })
  await button('Delete').click()
  await waitCount(0)
  const deleted = await info()
  let absent = await page.evaluate(async ({id, token}) => { try { await window.__aba.geometry.get(id, token); return 'SUCCESS' } catch (e) { return e.code } }, {id: before.geometries[0].id, token: before.identity})
  await menu('Insert...')
  await page.waitForFunction(() => window.__abaPicker.opens > 0 && window.__abaPicker.reads.length > 0, null, { timeout: 30000 })
  await waitCount(1)
  const reads = await page.evaluate(() => window.__abaPicker.reads)
  for (const read of reads) assert.deepEqual(read, saved, 'fake file read must match saved bytes')
  const after = await info()
  const oldLookup = await page.evaluate(async ({id, token}) => { try { return { result: await window.__aba.geometry.get(id, token) } } catch (e) { return { code: e.code } } }, {id: before.geometries[0].id, token: before.identity})
  console.log(JSON.stringify({before, deleted, absent, after, oldLookup}, null, 2))
  assert.deepEqual(deleted.identity, before.identity)
  assert.equal(absent, 'GEOMETRY_NOT_FOUND')
  assert.deepEqual(after.identity, before.identity)
  assert.equal(after.geometries[0].id, before.geometries[0].id)
  assert.equal(after.geometries[0].type, before.geometries[0].type)
  assert.equal(oldLookup.result.geometry.id, before.geometries[0].id)
  assert.equal(oldLookup.result.geometry.type, before.geometries[0].type)
  assert.deepEqual(downloads, [])
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__aba.close())
  console.log('PASS: observed identity, geometry ID and type after delete and insert; fake saved/read bytes match')
} finally { await browser.close() }
