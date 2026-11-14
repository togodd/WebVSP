// Isolated real-WASM regression. Point WEBVSP_TEST_PAGE at the matching Vite/WASM test server.
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/mirror/tree-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: tree check timed out'); process.exit(1) }, 180000)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => window.crossOriginIsolated), true)
  await page.evaluate(async () => {
    const engine = window.__webvspEngine
    const initial = await engine.testCall('model', '', '', 0)
    if (initial.geoms.length) throw Error('Expected isolated empty model')
    const call = (op, a, b = '') => engine.testCallGuarded(op, a, b, 0, initial.modelEpoch)
    const body = await call('addGeom', 'FUSELAGE')
    await call('addGeom', 'WING', body.id)
    await call('addGeom', 'POD')
  })
  // API creation doesn't wake the screen; Add triggers its normal GUI refresh.
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const tree = page.locator('.m-w.m-tree').first()
  const parent = tree.locator('.m-titem').filter({ hasText: 'FuselageGeom' })
  const child = tree.locator('.m-titem').filter({ hasText: 'WingGeom' })
  await child.waitFor({ timeout: 30000 })
  const toggle = parent.locator('.m-twist')
  await toggle.waitFor()
  // Exercise near the actual edges, including subpixel rounding, at native and
  // reduced dock scale. Use real mouse coordinates (locator positions are unscaled).
  for (const height of [1000, 550]) {
    await page.setViewportSize({ width: 1600, height })
    await page.waitForFunction(({ height }) => {
      const twist = document.querySelector('.m-twist')
      const width = twist?.getBoundingClientRect().width ?? 0
      return height === 1000 ? width > 8.9 : width > 0 && width < 8
    }, { height }, { timeout: 10000 })
    for (const [fx, fy] of [[0.04, 0.04], [0.96, 0.04], [0.04, 0.96], [0.96, 0.96]]) {
      for (const expanding of [false, true]) {
        const box = await toggle.boundingBox()
        assert.ok(box)
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
        await child.waitFor({ state: expanding ? 'visible' : 'detached', timeout: 10000 })
        assert.equal((await toggle.innerText()).trim(), expanding ? '−' : '+')
        assert.equal(await tree.locator('.m-titem').filter({ hasText: 'PodGeom' }).count(), 2)
      }
    }
    console.log(`PASS: four corners collapse and expand at viewport height ${height}`)
  }
  assert.deepEqual(errors, [])
} finally { await browser.close(); clearTimeout(deadline) }
