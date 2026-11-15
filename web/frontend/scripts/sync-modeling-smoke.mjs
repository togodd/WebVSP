// Fixed integration test against a disposable browser tab; creates a wing.
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
  await page.waitForFunction(() => typeof window.__runSyncModelingProbe === 'function')
  const before = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  const closed = new Promise((resolve) => {
    const listener = (worker) => { if (worker.url().includes('syncWorker-')) { worker.once('close', () => resolve(true)); page.off('worker', listener) } }
    page.on('worker', listener)
  })
  const result = await page.evaluate(() => window.__runSyncModelingProbe())
  if (!(await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]))) throw new Error('Worker was not terminated')
  const model = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  if (model.geoms.length !== before.geoms.length + 1 || !model.geoms.some((g) => g.id === result.wingId && g.type === 'Wing' && g.name === 'SyncModelWing')) throw new Error('Created/renamed/deleted geometries do not match page model')
  const origin = await page.evaluate((geom) => window.__webvspEngine.request('GET', `/geoms/${encodeURIComponent(geom)}/origin`), result.wingId)
  if (origin[0] !== result.readback || result.actualValue !== result.readback || result.requestedValue !== result.readback || result.oldValue === result.readback) throw new Error('Independent origin readback mismatch')
  for (const name of ['invalid_id', 'invalid_rename', 'invalid_delete', 'empty_name', 'invalid_parameter', 'outside_limits', 'unsupported_geom', 'unsupported_update']) if (result.errors[name]?.outcome !== 'not_written') throw new Error(`Missing failure evidence: ${name}`)
  if (result.fileReply !== 'openvsp-to-python\n' || !result.poisonedSessionChecked) throw new Error('File roundtrip or timeout handling failed')
  await page.evaluate((id) => window.__webvspEngine.request('POST', '/pick', { id }), result.wingId)
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.m-tlabel')).some((e) => e.textContent?.includes('SyncModelWing')), null, { timeout: 20_000 })
  await page.getByText('XForm', { exact: true }).first().click()
  await page.waitForFunction((expected) => Array.from(document.querySelectorAll('input.m-input')).some((input) => input.value.trim() === expected.toFixed(3)), result.readback, { timeout: 20_000 })
  if (external.length || errors.length) throw new Error(`Unexpected browser requests/errors: ${JSON.stringify({ external, errors })}`)
  console.log(JSON.stringify({ ...result, independentOrigin: origin, guiVisible: true, externalRequests: external.length }))
} finally { await browser.close() }
