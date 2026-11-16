// UI smoke for the current-model geometry analysis window.
// Run against a served production build:
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/p1-current-smoke.mjs
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const failures = []
try {
  const page = await browser.newPage()
  const errors = [], external = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })

  const open = async () => {
    const url = new URL(base)
    url.searchParams.set('dualWasmProbe', '1')
    await page.goto(url.href)
    await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
    await page.click('[data-testid="analysis-open"]')
    await page.waitForSelector('[data-testid="analysis-window"]')
  }
  const run = async () => {
    await page.click('[data-testid="analysis-run"]')
    await page.waitForSelector('[data-testid="analysis-results"], [data-testid="analysis-error"]', { timeout: 240_000 })
    if (await page.$('[data-testid="analysis-error"]')) return { error: await page.textContent('[data-testid="analysis-error"]') }
    const text = await page.textContent('[data-testid="analysis-results"]')
    const rows = await page.$$eval('[data-testid="analysis-results"] tbody tr', trs => trs.map(tr => [...tr.children].map(td => td.textContent)))
    return { text, rows }
  }

  // Empty model: the window reports why it cannot run.
  await open()
  const empty = await run()
  if (!empty.error || !/no geometry/i.test(empty.error)) failures.push(`empty model not rejected: ${JSON.stringify(empty)}`)
  else console.log('PASS empty model reported')

  // Attached geometry is outside the supported subset.
  await open()
  const wing = await page.evaluate(() => window.__webvspEngine.request('POST', '/geoms', { type: 'WING' }))
  await page.evaluate(id => window.__webvspEngine.request('POST', '/geoms', { type: 'POD', parent: id }), wing.id)
  const attached = await run()
  if (!attached.error || !/outside the supported subset/i.test(attached.error)) failures.push(`attached geom not rejected: ${JSON.stringify(attached)}`)
  else console.log('PASS attached geometry reported')

  // Supported model: real analysis, table, unchanged page model, repeatable.
  await open()
  await page.evaluate(async () => {
    const engine = window.__webvspEngine
    await engine.request('POST', '/geoms', { type: 'WING' })
    await engine.request('POST', '/geoms', { type: 'POD' })
    await engine.request('POST', '/geoms', { type: 'PROP' })
  })
  const before = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  const first = await run()
  if (first.error) failures.push(`supported model failed: ${first.error}`)
  else {
    if (first.rows.length !== 3) failures.push(`expected 3 geometry rows: ${JSON.stringify(first.rows)}`)
    if (!/源模型与隔离副本指纹一致|fingerprints match/.test(first.text) || !/未改动|unchanged/.test(first.text)) failures.push(`missing equivalence note: ${first.text}`)
    console.log(`PASS current-model analysis ${JSON.stringify({ rows: first.rows })}`)
  }
  const after = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  if (JSON.stringify(before) !== JSON.stringify(after)) failures.push('page model changed during current-model analysis')
  else console.log('PASS page model unchanged')

  const second = await run()
  if (second.error || JSON.stringify(second.rows) !== JSON.stringify(first.rows)) failures.push(`repeat run differs: ${JSON.stringify(second)}`)
  else console.log('PASS repeat run stable')

  // One analysis only: uncheck SurfacePatches.
  await page.uncheck('[data-testid="analysis-opt-patches"]')
  const single = await run()
  if (single.error) failures.push(`single-analysis run failed: ${single.error}`)
  else if (!single.text.includes('面片 0') && !single.text.includes('Patches 0')) failures.push(`patches not skipped: ${single.text}`)
  else console.log('PASS single analysis')

  if (external.length || errors.length) failures.push(`unexpected requests/errors: ${JSON.stringify({ external, errors })}`)
  console.log(JSON.stringify({ failures }, null, 2))
  if (failures.length) process.exitCode = 1
} finally { await browser.close() }
