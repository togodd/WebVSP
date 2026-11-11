// Isolated GUI regression probe: invalid Open followed by Save uses only a virtual file handle.
// Run from web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/gui-invalid-open-save-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    window.__probe = { opens: 0, savePickers: 0, events: [], bytes: null }
    const handle = {
      name: 'invalid-open-probe.vsp3',
      getFile: async () => new File(['not a vsp3 file'], 'invalid-open-probe.vsp3'),
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => {
        window.__probe.events.push('createWritable')
        return {
          write: async data => { const bytes = new Uint8Array(data); window.__probe.bytes = Array.from(bytes); window.__probe.events.push('write') },
          close: async () => { window.__probe.events.push('close') },
        }
      },
    }
    window.showOpenFilePicker = async () => { window.__probe.opens++; return [handle] }
    window.showSaveFilePicker = async () => { window.__probe.savePickers++; throw new DOMException('Cancelled', 'AbortError') }
  })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const req = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  await req('POST', '/geoms', { type: 'FUSELAGE' })
  const before = await page.evaluate(() => window.__webvspEngine.testCall('model'))
  assert.equal(before.geoms.length, 1)
  const fileMenu = async () => page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
  await fileMenu()
  const labels = await page.locator('.menu-list button').allTextContents()
  console.log('Observed File menu labels:', JSON.stringify(labels))
  await page.locator('.menu-list').getByRole('button', { name: 'Open...', exact: true }).click()
  await page.waitForFunction(() => window.__probe.opens === 1, { timeout: 30000 })
  const alert = page.getByRole('dialog')
  await alert.waitFor({ timeout: 30000 })
  await assert.match(await alert.innerText(), /Failed to read the selected file\. The previous model has been replaced; the current model is unnamed\./)
  await alert.getByRole('button').click()
  await page.waitForFunction(epoch => window.__webvspEngine.testCall('model').then(m => m.modelEpochValid && m.modelEpoch !== epoch), before.modelEpoch, { timeout: 30000 })
  const after = await page.evaluate(() => window.__webvspEngine.testCall('model'))
  assert.equal(after.geoms.length, 0)
  console.log('After invalid Open:', JSON.stringify({ epochChanged: before.modelEpoch !== after.modelEpoch, geoms: after.geoms.length, events: await page.evaluate(() => window.__probe.events) }))
  await fileMenu()
  console.log('File menu after invalid Open:', JSON.stringify(await page.locator('.menu-list button').allTextContents()))
  await page.locator('.menu-list').getByRole('button', { name: /^Save\.\.\./ }).click()
  await page.waitForFunction(() => window.__probe.savePickers === 1, null, { timeout: 30000 })
  // Allow the cancelled picker answer and linked-file watcher to settle.
  await page.waitForTimeout(3000)
  const result = await page.evaluate(() => window.__probe)
  console.log('After Save:', JSON.stringify(result))
  assert.deepEqual(errors, [])
  assert.equal(result.savePickers, 1, 'Save must ask for a new destination')
  assert.deepEqual(result.events, [], 'Save must not write through the selected invalid handle')
  assert.equal(result.bytes, null)
  console.log('PASS: invalid Open followed by cancelled Save did not write the selected virtual handle')
} finally { await browser.close() }
