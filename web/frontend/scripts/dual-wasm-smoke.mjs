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
  if (result.errorOutcome !== 'not_written' || !result.error || !result.unsupportedError.includes('Unsupported probe operation')) throw new Error('Bridge errors were not propagated')
  if (result.parameterName !== 'X_Rel_Location' || result.parameterGroup !== 'XForm' || result.requestedValue !== result.readback || result.actualValue !== result.readback || result.oldValue === result.readback) throw new Error('Parameter write/readback mismatch')
  if (result.bindingSignature !== "(type, parent='')" || result.parmType !== 0 || result.parmDoubleType !== result.parmType) throw new Error('Generated signature or enum mismatch')
  const parameter = await page.evaluate(({ geom, parm }) => window.__webvspEngine.request('GET', `/geoms/${encodeURIComponent(geom)}/parms/${encodeURIComponent(parm)}`), { geom: result.wingId, parm: result.parameterId })
  if (parameter.value !== result.readback || parameter.container !== result.wingId) throw new Error('Page engine parameter does not match Python')
  const origin = await page.evaluate((geom) => window.__webvspEngine.request('GET', `/geoms/${encodeURIComponent(geom)}/origin`), result.wingId)
  if (origin[0] !== result.readback) throw new Error('Geometry position does not match updated parameter')
  await page.getByText('XForm', { exact: true }).first().click()
  await page.waitForFunction((expected) => Array.from(document.querySelectorAll('input.m-input')).some((input) => input.value.trim() === expected.toFixed(3)), result.readback, { timeout: 20_000 })
  if (external.length) throw new Error(`Unexpected external requests: ${external.join(', ')}`)
  console.log(JSON.stringify({ ...result, sameModel: true, guiWingVisible: true, externalRequests: external.length }))
} finally {
  await browser.close()
}
