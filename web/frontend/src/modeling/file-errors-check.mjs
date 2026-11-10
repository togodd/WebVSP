// Tests low-level file ops through the development-only bridge against rebuilt WASM.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const call = (op, a = '') => page.evaluate(({ op, a }) => window.__webvspEngine.testCall(op, a), { op, a })
  await call('addGeom', 'FUSELAGE')
  const before = await call('model')
  assert.equal(before.geoms.length, 1)
  assert.equal(before.dirty, true)
  await assert.rejects(() => call('writeFile', '/does-not-exist/model.vsp3'))
  const afterWrite = await call('model')
  assert.equal(afterWrite.dirty, true)
  assert.equal(afterWrite.geoms.length, 1)
  await assert.rejects(() => call('readFile', '/does-not-exist/model.vsp3'))
  const afterRead = await call('model')
  assert.equal(afterRead.dirty, true)
  assert.equal(afterRead.geoms.length, 0)
  assert.deepEqual(errors, [])
  console.log('PASS: failed file operations keep model dirty; failed open is destructive')
} finally { await browser.close() }
