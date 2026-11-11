// Regression: a secondary import must not be delivered to the previously linked handle.
// Uses disposable browser contexts and fake handles only, never host disk files.
// Requires a Vite dev server: its testCall writes a real model as a positive control.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })
  try {
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      window.__collisionProbe = { opens: 0, events: [], written: null }
      const fake = (name, text) => ({
        name, getFile: async () => new File([text], name),
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => {
          window.__collisionProbe.events.push('createWritable:' + name)
          return {
            write: async bytes => { window.__collisionProbe.events.push('write:' + name); window.__collisionProbe.written = Array.from(new Uint8Array(bytes)) },
            close: async () => { window.__collisionProbe.events.push('close:' + name) },
          }
        },
      })
      const old = fake('old.vsp3', 'old invalid original')
      const main = fake('main.vsp3', 'invalid main')
      const secondary = fake('old.vsp3', 'SECONDARY COLLISION PAYLOAD')
      window.showOpenFilePicker = async () => ++window.__collisionProbe.opens === 1 ? [old] : [main, secondary]
    })
    await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    assert.equal(await page.evaluate(() => crossOriginIsolated), true)
    const open = async () => {
      await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
      await page.locator('.menu-list').getByRole('button', { name: 'Open...', exact: true }).click()
      const alert = page.getByRole('dialog').filter({ hasText: 'Failed to read the selected file' })
      await alert.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 30000 })
    }
    await open()
    assert.deepEqual(await page.evaluate(() => window.__collisionProbe.events), [])
    // Positive control: a genuine engine write reaches the first linked handle.
    await page.evaluate(() => window.__webvspEngine.testCall('writeFile', '/home/web_user/old.vsp3'))
    await page.waitForFunction(() => window.__collisionProbe.events.includes('close:old.vsp3'), null, { timeout: 15000 })
    assert.deepEqual(await page.evaluate(() => window.__collisionProbe.events), ['createWritable:old.vsp3', 'write:old.vsp3', 'close:old.vsp3'])
    await page.evaluate(() => { window.__collisionProbe.events = []; window.__collisionProbe.written = null })
    await open()
    // The watcher is driven by the 16ms engine tick; allow many cycles after import.
    await page.waitForTimeout(1000)
    const result = await page.evaluate(() => ({ ...window.__collisionProbe }))
    assert.equal(result.opens, 2)
    assert.deepEqual(result.events, [])
    assert.equal(result.written, null)
    assert.deepEqual(errors, [])
    console.log('PASS: linked watcher observed a real write but did not deliver the secondary import to the old handle')
  } finally { await context.close() }
} finally { await browser.close() }
