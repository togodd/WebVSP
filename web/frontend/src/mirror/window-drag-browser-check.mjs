// Test the production page in an isolated browser context. Does not change the user's model.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ executablePath: process.env.WEBVSP_TEST_CHROMIUM, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:8090/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await page.getByRole('button', { name: /CompGeom/ }).click()
  const win = page.locator('.m-float').filter({ has: page.locator('.m-float-title', { hasText: /Comp\s*Geom/i }) }).first()
  await win.waitFor({ timeout: 30000 })
  const title = win.locator('.m-float-title')
  await page.waitForTimeout(250)
  const before = await win.boundingBox()
  const tb = await title.boundingBox()
  await page.mouse.move(tb.x + 40, tb.y + tb.height / 2)
  await page.mouse.down()
  await page.mouse.move(tb.x + 220, tb.y + tb.height / 2 + 120, { steps: 40 })
  await page.mouse.up()
  const after = await win.boundingBox()
  assert(Math.abs(after.x - before.x - 180) < 3, `horizontal move: ${after.x - before.x}`)
  assert(Math.abs(after.y - before.y - 120) < 3, `vertical move: ${after.y - before.y}`)
  await page.waitForTimeout(500)
  const settled = await win.boundingBox()
  assert(Math.abs(settled.x - after.x) < 1 && Math.abs(settled.y - after.y) < 1, 'position must persist after rendering')
  await win.locator('.m-float-title button').click()
  await win.waitFor({ state: 'detached', timeout: 10000 })
  console.log('PASS: CompGeom drag tracks pointer, retains final position and closes')
} finally { await browser.close() }
