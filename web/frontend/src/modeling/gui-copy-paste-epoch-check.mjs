// Disposable browser session against the test server and its production WASM.
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/gui-copy-paste-epoch-check.mjs
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
    window.__copyService = createBrowserModelingService()
  })
  const info = identity => page.evaluate(identity => window.__copyService.model.getInfo(identity), identity)
  const waitCount = count => page.waitForFunction(count => window.__copyService.model.getInfo().then(m => m.geometries.length === count), count, { timeout: 30000 })
  const button = name => page.getByRole('button', { name, exact: true }).first()
  assert.equal((await info()).geometries.length, 0, 'expected an isolated empty model')
  await page.locator('select').filter({ has: page.locator('option:text-is("FUSELAGE")') }).first().selectOption({ label: 'FUSELAGE' })
  await button('Add').click()
  await waitCount(1)
  const original = await info()
  const identity = original.identity
  await button('Copy').click()
  await button('Paste').click()
  await waitCount(2)
  const pasted = await info(identity)
  assert.deepEqual(pasted.identity, identity)
  assert.ok(pasted.geometries.some(g => g.id === original.geometries[0].id))
  const newGeoms = pasted.geometries.filter(g => !original.geometries.some(o => o.id === g.id))
  assert.equal(newGeoms.length, 1)
  assert.equal(newGeoms[0].type, original.geometries[0].type)

  // Copy the entire visible set, remove all of it, then paste from the clipboard.
  // The resulting IDs are disjoint, but this is still the same model instance.
  await button('Sel All').click()
  await page.waitForFunction(identity => window.__copyService.model.getSelection(identity).then(s => s.geometryIds.length === 2), identity, { timeout: 30000 })
  await button('Copy').click()
  await button('Delete').click()
  await waitCount(0)
  assert.deepEqual((await info(identity)).identity, identity)
  await button('Paste').click()
  await waitCount(2)
  const replaced = await info(identity)
  assert.deepEqual(replaced.identity, identity)
  assert.equal(replaced.geometries.length, 2)
  assert.ok(replaced.geometries.every(g => !pasted.geometries.some(old => old.id === g.id)), 'pasted IDs must be disjoint from all deleted IDs')
  assert.deepEqual(replaced.geometries.map(g => g.type).sort(), pasted.geometries.map(g => g.type).sort())
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__copyService.close())
  console.log('PASS: GUI Copy/Paste preserves epoch and old token; deleting all originals and pasting preserves identity with disjoint geometry IDs')
} finally { await browser.close() }
