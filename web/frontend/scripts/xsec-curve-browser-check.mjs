// Real Chromium/Python/WASM regression for XSec alias, continuity and curve values.
// From web/frontend, with a disposable loopback dev server and a freshly built engine:
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=/path/to/chromium \
// WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/xsec-curve-browser-check.mjs
// The test clears and changes the model. It intercepts artifacts, not public files.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const { WEBVSP_TEST_PAGE: base, WEBVSP_TEST_CHROMIUM: executablePath, WEBVSP_TEST_WASM_DIR: dir } = process.env
if (!base || !executablePath || !dir) throw Error('Set WEBVSP_TEST_PAGE, WEBVSP_TEST_CHROMIUM and WEBVSP_TEST_WASM_DIR')
const url = new URL(base)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('A disposable loopback server is required')
const source = resolve('../../web/wasm/engine/engine.cpp')
const files = Object.fromEntries(await Promise.all(['vsp.js', 'vsp.wasm'].map(async name => {
  const path = resolve(dir, name)
  const [body, info] = await Promise.all([readFile(path), stat(path)])
  if (name === 'vsp.wasm' && info.mtimeMs < (await stat(source)).mtimeMs) throw Error(`Stale WASM: ${path} is older than ${source}`)
  return [name, { path, body, hash: createHash('sha256').update(body).digest('hex') }]
})))
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const errors = [], external = [], served = new Set(), failures = []
try {
  const page = await browser.newPage()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console error: ${msg.text()}`) })
  page.on('requestfailed', req => { if (req.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`request failed: ${req.url()} ${req.failure()?.errorText}`) })
  await page.route('**/*', async route => {
    const request = new URL(route.request().url())
    if (request.origin !== url.origin) { external.push(request.href); return route.abort() }
    const match = request.pathname.match(/\/wasm\/(vsp\.js|vsp\.wasm)$/)
    if (match) {
      served.add(match[1])
      return route.fulfill({ status: 200, body: files[match[1]].body, headers: { 'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
    }
    return route.continue()
  })
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  try { await page.waitForSelector('[data-ready="1"]', { timeout: 30000 }) }
  catch (e) { throw Error(`Engine did not start: ${e.message}; page errors=${JSON.stringify(errors)}; blocked=${JSON.stringify(external)}; served=${JSON.stringify([...served])}`) }
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)
  const cases = [
    ['aliases round trip on a wing section', `
import openvsp as vsp
vsp.ClearVSPModel()
wing = vsp.AddGeom('WING')
vsp.Update()
surf = vsp.GetXSecSurf(wing, 0)
assert vsp.GetNumXSec(surf) >= 2
xsec = vsp.GetXSec(surf, 1)

alias_before = vsp.GetXSecAlias(xsec)
curve_before = vsp.GetXSecCurveAlias(xsec)
assert isinstance(alias_before, str) and isinstance(curve_before, str)
vsp.SetXSecAlias(xsec, 'CurveCheck')
assert vsp.GetXSecAlias(xsec) == 'CurveCheck'
vsp.SetXSecCurveAlias(xsec, 'CurveCheckCurve')
assert vsp.GetXSecCurveAlias(xsec) == 'CurveCheckCurve'
# The two aliases are separate fields.
assert vsp.GetXSecAlias(xsec) != vsp.GetXSecCurveAlias(xsec)
vsp.SetXSecAlias(xsec, alias_before)
vsp.SetXSecCurveAlias(xsec, curve_before)
assert vsp.GetXSecAlias(xsec) == alias_before
assert vsp.GetXSecCurveAlias(xsec) == curve_before
`],
    ['continuity and curve values report the native skin-section limit', `
import openvsp as vsp
vsp.ClearVSPModel()
wing = vsp.AddGeom('WING')
vsp.Update()
xsec = vsp.GetXSec(vsp.GetXSecSurf(wing, 0), 1)
# Native SkinXSec-only accessors on this release's wing (XSecCurve) sections.
calls = [
    lambda: vsp.GetXSecContinuity(xsec),
    lambda: vsp.SetXSecContinuity(xsec, 0),
    lambda: vsp.GetXSecTanAngles(xsec, vsp.XSEC_LEFT_SIDE),
    lambda: vsp.SetXSecTanAngles(xsec, vsp.XSEC_LEFT_SIDE, 0.1, 0.2, 0.3, 0.4),
    lambda: vsp.GetXSecTanSlews(xsec, vsp.XSEC_RIGHT_SIDE),
    lambda: vsp.SetXSecTanSlews(xsec, vsp.XSEC_RIGHT_SIDE, 0.1, 0.2, 0.3, 0.4),
    lambda: vsp.GetXSecTanStrengths(xsec, vsp.XSEC_LEFT_SIDE),
    lambda: vsp.SetXSecTanStrengths(xsec, vsp.XSEC_LEFT_SIDE, 0.1, 0.2, 0.3, 0.4),
    lambda: vsp.GetXSecCurvatures(xsec, vsp.XSEC_RIGHT_SIDE),
    lambda: vsp.SetXSecCurvatures(xsec, vsp.XSEC_RIGHT_SIDE, 0.1, 0.2, 0.3, 0.4),
]
for call in calls:
    try:
        call()
    except vsp.OpenVSPError as exc:
        assert 'Skin XSec' in str(exc), exc
    else:
        raise AssertionError('SkinXSec-only accessor accepted a wing section')
`],
    ['invalid XSec and side arguments', `
import openvsp as vsp
vsp.ClearVSPModel()
wing = vsp.AddGeom('WING')
vsp.Update()
xsec = vsp.GetXSec(vsp.GetXSecSurf(wing, 0), 1)
calls = [
    lambda: vsp.GetXSecAlias('missing'),
    lambda: vsp.SetXSecAlias('missing', 'x'),
    lambda: vsp.GetXSecCurveAlias('missing'),
    lambda: vsp.SetXSecCurveAlias('missing', 'x'),
    lambda: vsp.GetXSecContinuity('missing'),
    lambda: vsp.SetXSecContinuity('missing', 0),
    lambda: vsp.GetXSecTanAngles('missing', vsp.XSEC_LEFT_SIDE),
    lambda: vsp.SetXSecTanAngles('missing', vsp.XSEC_LEFT_SIDE, 0, 0, 0, 0),
    lambda: vsp.GetXSecTanAngles(xsec, vsp.XSEC_BOTH_SIDES),
    lambda: vsp.SetXSecTanSlews(xsec, vsp.XSEC_BOTH_SIDES, 0, 0, 0, 0),
]
for call in calls:
    try:
        call()
    except vsp.OpenVSPError:
        pass
    else:
        raise AssertionError('invalid XSec or side accepted')
`],
  ]
  for (const [name, code] of cases) {
    try {
      const result = await page.evaluate(async code => {
        const { startConsoleSession } = await import('/src/dualWasmProbe/syncProbe.ts')
        const session = await startConsoleSession()
        try { return await session.run(code, true) } finally { session.close() }
      }, code)
      if (!result.ok) throw Error(result.error || JSON.stringify(result))
      console.log(`PASS ${name}`, result.stdout ?? '')
    } catch (error) {
      failures.push(`${name}: ${error.stack || error}`)
      console.error(`FAIL ${name}:`, error.message)
    }
  }
  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors)}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external)}`)
  if (failures.length) throw Error(failures.join('\n\n'))
} finally { await browser.close() }
