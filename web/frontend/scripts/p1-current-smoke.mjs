// Current-model P1: rejection paths and one real analysis of a serialized copy.
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
    await page.waitForFunction(() => typeof window.__runP1CurrentModelProbe === 'function')
  }
  const probe = () => page.evaluate(() => window.__runP1CurrentModelProbe().then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e.message })))

  // Empty model.
  await open()
  const empty = await probe()
  if (empty.ok || !/no geometry/.test(empty.error)) failures.push(`empty model not rejected: ${JSON.stringify(empty)}`)
  else console.log('PASS empty model rejected')

  // Attached geometry is outside the supported subset.
  await open()
  const wing = await page.evaluate(() => window.__webvspEngine.request('POST', '/geoms', { type: 'WING' }))
  await page.evaluate(id => window.__webvspEngine.request('POST', '/geoms', { type: 'POD', parent: id }), wing.id)
  const attached = await probe()
  if (attached.ok || !/outside the supported subset/.test(attached.error)) failures.push(`attached geom not rejected: ${JSON.stringify(attached)}`)
  else console.log('PASS attached geometry rejected')

  // Supported model: wing + pod + propeller, one edited parameter.
  await open()
  const built = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    const w = await engine.request('POST', '/geoms', { type: 'WING' })
    await engine.request('POST', '/geoms', { type: 'POD' })
    await engine.request('POST', '/geoms', { type: 'PROP' })
    const ids = await engine.testCall?.('geomParmIDs', w.id)
    return { wing: w.id, ids: ids ?? null }
  })
  const before = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  const first = await probe()
  if (!first.ok) failures.push(`supported model failed: ${JSON.stringify(first)}`)
  else {
    const r = first.value
    if (r.isolation !== 'disposable-model-snapshot' || r.pageModelUsed !== true) failures.push(`bad isolation: ${JSON.stringify(r)}`)
    if (!/^[0-9a-f]{16}$/.test(r.modelFingerprint)) failures.push(`bad fingerprint: ${JSON.stringify(r.modelFingerprint)}`)
    if (r.xmlBytes <= 0) failures.push('empty XML')
    const report = r.reports?.[0]
    if (report?.modelFingerprint !== r.modelFingerprint) failures.push(`fingerprint mismatch between source and copy: ${JSON.stringify(report?.modelFingerprint)}`)
    if (!report?.DegenGeom?.objects || !report?.SurfacePatches?.patches) failures.push(`empty analysis: ${JSON.stringify(report)}`)
    else console.log(`PASS current-model analysis ${JSON.stringify({ fingerprint: r.modelFingerprint, xmlBytes: r.xmlBytes, objects: report.DegenGeom.objects, patches: report.SurfacePatches.patches })}`)
  }
  const after = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  if (JSON.stringify(before) !== JSON.stringify(after)) failures.push('page model changed during current-model analysis')
  else console.log('PASS page model unchanged')

  // Repeatability: a second run must give the same fingerprint.
  const second = await probe()
  if (!second.ok) failures.push(`repeat run failed: ${JSON.stringify(second)}`)
  else if (second.value.modelFingerprint !== first.value?.modelFingerprint) failures.push('fingerprint changed between identical runs')
  else console.log('PASS repeat run stable')

  if (external.length || errors.length) failures.push(`unexpected requests/errors: ${JSON.stringify({ external, errors })}`)
  console.log(JSON.stringify({ built, failures }, null, 2))
  if (failures.length) process.exitCode = 1
} finally { await browser.close() }
