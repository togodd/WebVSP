// Run against the deployed production app with an installed Chromium.
import { chromium } from 'playwright-core'
const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const external = []
  const errors = []
  page.on('request', (r) => { if (new URL(r.url()).origin !== new URL(base).origin) external.push(r.url()) })
  page.on('pageerror', (e) => errors.push(e.message))
  const url = new URL(base)
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__runSyncWasmProbe === 'function')
  const missing = await page.evaluate(() => window.__runSyncWasmProbe().then(() => '', (e) => e.message))
  if (!missing.includes('Add a wing')) throw new Error(`Missing-wing failure not reported: ${missing}`)
  const { id } = await page.evaluate(() => window.__webvspEngine.request('POST', '/geoms', { type: 'WING' }))
  const terminated = new Promise((resolve) => {
    const listener = (worker) => { if (worker.url().includes('syncWorker-')) { worker.once('close', () => resolve(true)); page.off('worker', listener) } }
    page.on('worker', listener)
  })
  const result = await page.evaluate(() => window.__runSyncWasmProbe())
  if (!(await Promise.race([terminated, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]))) throw new Error('Sync worker was not terminated')
  const ids = await page.evaluate((geom) => window.__webvspEngine.request('GET', `/geoms/${encodeURIComponent(geom)}/parms`), id)
  const metadata = []
  for (const parm of ids) metadata.push(await page.evaluate(({ geom, parm }) => window.__webvspEngine.request('GET', `/geoms/${encodeURIComponent(geom)}/parms/${encodeURIComponent(parm)}`), { geom: id, parm }))
  const expected = ['TotalArea', 'TotalSpan', 'TotalChord'].map((name) => {
    const matches = metadata.filter((p) => p.name === name && p.group === 'WingGeom' && p.container === id)
    if (matches.length !== 1) throw new Error(`Independent parameter lookup failed: ${name}`)
    return matches[0].value
  })
  if (result.wingId !== id || !result.nameUnique || JSON.stringify(result.byId) !== JSON.stringify(expected) || JSON.stringify(result.byName) !== JSON.stringify(expected) || result.fileReply !== 'openvsp-to-python\n' || !result.timeoutChecked) throw new Error(`Sync result mismatch: ${JSON.stringify(result)}`)
  if (external.length || errors.length) throw new Error(`Unexpected browser requests/errors: ${JSON.stringify({ external, errors })}`)
  console.log(JSON.stringify({ ...result, independentValues: expected, isolated: await page.evaluate(() => crossOriginIsolated), externalRequests: external.length }))
} finally {
  await browser.close()
}
