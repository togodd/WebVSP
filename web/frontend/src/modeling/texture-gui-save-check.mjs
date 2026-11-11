// Regression for Texture::EncodeXml. Run from web/frontend against the modeling
// test server with a WASM build containing the fix:
// WEBVSP_TEST_PAGE=http://127.0.0.1:5179/ WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/texture-gui-save-check.mjs
// Fresh context and in-memory picker handles: no host files or user profile are used.
// The first save is through the real mirrored GUI. The second uses the dev-only
// engine call to write to a different MEMFS directory: browser picker names are
// basenames and the GUI maps them all into /home/web_user.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
const testPage = process.env.WEBVSP_TEST_PAGE
if (!executablePath || !testPage) throw new Error('Set WEBVSP_TEST_CHROMIUM and WEBVSP_TEST_PAGE to a trusted modeling test server')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false })
try {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // Expose the actual module's MEMFS for a read-only assertion on the second
  // save. All engine logic and the original WASM remain unchanged.
  await page.route('**/wasm/vsp.js', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const marker = ';return Module}export default createVspModule;'
    assert.equal(source.split(marker).length, 2, 'Unsupported Emscripten loader shape')
    await route.fulfill({ response, body: source.replace(marker, ';globalThis.__textureTestModule=Module;return Module}export default createVspModule;') })
  })
  await page.addInitScript(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    window.__textureTest = { opens: 0, saves: [] }
    window.showOpenFilePicker = async () => {
      window.__textureTest.opens++
      return [{ name: 'texture.png', getFile: async () => new File([png], 'texture.png'), queryPermission: async () => 'granted', requestPermission: async () => 'granted' }]
    }
    window.showSaveFilePicker = async () => ({
      name: 'texture-first.vsp3', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => {
        let bytes
        return { write: async data => { bytes = new Uint8Array(data) }, close: async () => { window.__textureTest.saves.push(new TextDecoder().decode(bytes)) } }
      },
    })
  })
  await page.goto(testPage)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.locator('select').filter({ has: page.locator('option:text-is("WING")') }).first().selectOption({ label: 'WING' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.locator('.m-menubar').getByRole('button', { name: 'Model', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'Texture...', exact: true }).click()
  await page.getByRole('button', { name: 'Add...', exact: true }).click()
  await page.locator('option').filter({ hasText: 'texture.png' }).waitFor({ state: 'attached', timeout: 30000 })
  assert.equal(await page.evaluate(() => window.__textureTest.opens), 1)
  await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'Save As...', exact: true }).click()
  // Inspect the first delivered snapshot, so an incomplete write cannot be hidden
  // by a later delivery.
  await page.waitForFunction(() => window.__textureTest.saves.length > 0, null, { timeout: 30000 })
  const first = await page.evaluate(() => window.__textureTest.saves[0])
  assert.equal(await page.evaluate(() => window.__textureTestModule.FS.analyzePath('/home/web_user/texture.png').exists), true)
  const result = await page.evaluate(() => window.__webvspEngine.testCall('writeFile', '/home/texture-second.vsp3'))
  assert.equal(result.path, '/home/texture-second.vsp3')
  const second = await page.evaluate(() => new TextDecoder().decode(window.__textureTestModule.FS.readFile('/home/texture-second.vsp3')))
  const paths = xml => page.evaluate(text => {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.querySelector('parsererror')) throw new Error(`Invalid saved XML: ${doc.querySelector('parsererror').textContent}; prefix: ${JSON.stringify(text.slice(0, 200))}`)
    return [...doc.querySelectorAll('Textures File_Name')].map(node => node.textContent)
  }, xml)
  assert.deepEqual(await paths(first), ['texture.png'])
  assert.deepEqual(await paths(second), ['web_user/texture.png'])
  assert.deepEqual(errors, [])
  console.log('PASS: GUI texture and first save; second save in a different MEMFS directory retains correct texture path')
} finally {
  await context.close()
  await browser.close()
}
