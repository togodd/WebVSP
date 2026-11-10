// Isolated browser regression for File > New. The picker is fully fake: no user files are touched.
// Run from web/frontend against a dev server with rebuilt WASM:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium WEBVSP_TEST_PAGE=http://127.0.0.1:5179/ node src/modeling/gui-new-save-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  for (const scenario of ['cancel', 'discard', 'success', 'write-failure']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      await page.addInitScript(mode => {
        window.__picker = { calls: 0, writes: 0 }
        window.showSaveFilePicker = async () => {
          window.__picker.calls++
          if (mode === 'cancel') throw new DOMException('Cancelled', 'AbortError')
          return {
            // The missing parent exists only as a path in MEMFS and forces xmlSaveFormatFile to fail.
            name: mode === 'write-failure' ? 'missing-parent-for-test/model.vsp3' : 'gui-new-test.vsp3',
            queryPermission: async () => 'granted', requestPermission: async () => 'granted',
            createWritable: async () => ({ write: async () => { window.__picker.writes++ }, close: async () => {} }),
          }
        }
      }, scenario)
      await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      assert.equal(await page.evaluate(() => crossOriginIsolated), true)
      const call = (op, a = '') => page.evaluate(({ op, a }) => window.__webvspEngine.testCall(op, a), { op, a })
      await call('addGeom', 'FUSELAGE')
      const before = await call('model')
      assert.equal(before.geoms.length, 1)
      assert.equal(before.modelEpochValid, true)
      await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
      await page.locator('.menu-list').getByRole('button', { name: 'New', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: scenario === 'discard' ? 'Discard' : 'Save', exact: true }).click()
      if (scenario !== 'discard') await page.waitForFunction(() => window.__picker.calls === 1, { timeout: 30000 })
      if (scenario === 'discard' || scenario === 'success') {
        await page.waitForFunction(epoch => window.__webvspEngine.testCall('model').then(m => m.modelEpochValid && m.modelEpoch !== epoch), before.modelEpoch, { timeout: 30000 })
        assert.equal((await call('model')).geoms.length, 0)
      } else {
        // Let the asynchronous picker answer and the GUI callback finish before checking.
        await page.waitForTimeout(1000)
        const after = await call('model')
        assert.equal(after.modelEpoch, before.modelEpoch)
        assert.deepEqual(after.geoms, before.geoms)
      }
      assert.equal(await page.evaluate(() => window.__picker.calls), scenario === 'discard' ? 0 : 1)
      if (scenario === 'write-failure') assert.equal(await page.evaluate(() => window.__picker.writes), 0)
      assert.deepEqual(errors, [])
      console.log(`PASS: New ${scenario}`)
    } finally { await context.close() }
  }
  console.log('Save success above means MEMFS write succeeded, not durable disk persistence.')
} finally { await browser.close() }
