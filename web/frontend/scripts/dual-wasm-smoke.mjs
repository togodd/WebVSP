// Against the deployed app: WEBVSP_URL=http://127.0.0.1:8090/ CHROMIUM_PATH=... node scripts/dual-wasm-smoke.mjs
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:8090/'
const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const external = []
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(base).origin) external.push(request.url())
  })
  const url = new URL(base)
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__runDualWasmProbe === 'function')
  const result = await page.evaluate(() => window.__runDualWasmProbe())
  const model = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.m-tlabel')).some((element) => element.textContent?.includes('WingGeom')), null, { timeout: 20_000 })
  if (result.beforeCount !== 0 || result.afterCount !== 1 || !model.geoms.some((geom) => geom.id === result.wingId && geom.type === 'Wing')) throw new Error('Python and page model do not match')
  if (!result.error.includes('Unsupported probe operation')) throw new Error('Bridge error was not propagated')
  if (external.length) throw new Error(`Unexpected external requests: ${external.join(', ')}`)
  console.log(JSON.stringify({ ...result, sameModel: true, guiWingVisible: true, externalRequests: external.length }))
} finally {
  await browser.close()
}
