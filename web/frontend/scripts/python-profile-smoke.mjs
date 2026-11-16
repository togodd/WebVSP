// Warm Python console profiling and SurfacePatches baseline on a fresh model.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(process.env.WEBVSP_URL || 'http://127.0.0.1:4173/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.click('[data-testid="console-open"]')
  async function run(code) {
    const count = await page.locator('.py-console-entry').count()
    await page.locator('[data-testid="console-input"]').fill(code)
    await page.locator('[data-testid="console-run"]').click()
    await page.waitForFunction(n => document.querySelectorAll('.py-console-entry').length > n, count, { timeout: 180_000 })
    const entry = page.locator('.py-console-entry').last()
    return { value: await entry.locator('.py-console-value').textContent().catch(() => ''), error: await entry.locator('.py-console-error').textContent().catch(() => ''), meta: await entry.locator('.py-console-meta').textContent() }
  }
  const setup = await run('import openvsp as vsp, surface_patches\nw = vsp.AddGeom("WING")\nvsp.Update()')
  assert.equal(setup.error, '')
  const result = await run('comps = surface_patches.export_surface_patches(vsp.SET_ALL)\n[(c.name, len(c.surfaces), sum(len(s.patches) for s in c.surfaces)) for c in comps]')
  assert.equal(result.error, '')
  assert.match(result.value, /WingGeom/)
  assert.match(result.meta, /\d+ bridge calls · \d+ ms bridge wait · \d+ KiB/)
  assert.ok(Number(result.meta.match(/(\d+) bridge calls/)[1]) > 0)
  const empty = await run('1 + 1')
  assert.equal(empty.error, '')
  assert.match(empty.meta, /0 bridge calls · 0 ms bridge wait · 0 KiB/)
  console.log(JSON.stringify({ baseline: result, reset: empty.meta }))
} finally { await browser.close() }
