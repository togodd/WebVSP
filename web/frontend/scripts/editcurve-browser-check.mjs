// Real Chromium/Python/WASM regression for the editable XSec curve API.
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine \
//   node scripts/editcurve-browser-check.mjs
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
  catch (e) { throw Error(`Engine did not start: ${e.message}`) }
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)
  const cases = [
    ['control points, fixed flags and move', `
import openvsp as vsp
vsp.ClearVSPModel()
fuselage = vsp.AddGeom('FUSELAGE')
vsp.Update()
surf = vsp.GetXSecSurf(fuselage, 0)
xsec = vsp.GetXSec(surf, 2)
vsp.ChangeXSecShapeByID(xsec, vsp.XS_EDIT_CURVE)
vsp.Update()
assert vsp.GetXSecShape(xsec) == vsp.XS_EDIT_CURVE

points = vsp.GetEditXSecCtrlVec(xsec)
assert isinstance(points, list) and len(points) >= 4, points
first = points[0]
assert all(abs(c) < 1e9 for c in (first.x(), first.y(), first.z()))

fixed = vsp.GetEditXSecFixedUVec(xsec)
assert isinstance(fixed, list) and len(fixed) == len(points), (len(fixed), len(points))
flipped = [not flag for flag in fixed]
vsp.SetEditXSecFixedUVec(xsec, flipped)
assert vsp.GetEditXSecFixedUVec(xsec) == flipped
vsp.SetEditXSecFixedUVec(xsec, fixed)
assert vsp.GetEditXSecFixedUVec(xsec) == fixed

# Moving a control point changes it in the returned list.
index = 1
before = vsp.GetEditXSecCtrlVec(xsec)[index]
moved = (before.x() + 0.05, before.y(), before.z())
vsp.MoveEditXSecPnt(xsec, index, moved)
after = vsp.GetEditXSecCtrlVec(xsec)[index]
assert abs(after.x() - moved[0]) < 1e-6, (after.x(), moved[0])

# Writing the control points back keeps the count.
count = len(vsp.GetEditXSecCtrlVec(xsec))
us = [i / (count - 1) for i in range(count)]
ws = [0.5] * count
pts = [(p.x(), p.y(), p.z()) for p in vsp.GetEditXSecCtrlVec(xsec)]
vsp.SetEditXSecPnts(xsec, us, pts, ws)
vsp.Update()
assert len(vsp.GetEditXSecCtrlVec(xsec)) == count
`],
    ['split adds a section', `
import openvsp as vsp
vsp.ClearVSPModel()
fuselage = vsp.AddGeom('FUSELAGE')
vsp.Update()
surf = vsp.GetXSecSurf(fuselage, 0)
before = vsp.GetNumXSec(surf)
xsec = vsp.GetXSec(surf, 2)
vsp.ChangeXSecShapeByID(xsec, vsp.XS_EDIT_CURVE)
vsp.Update()
index = vsp.EditXSecSplit01(xsec, 0.5)
vsp.Update()
assert isinstance(index, int) and index >= 0, index
# The split yields a usable section index on the same surface.
assert vsp.GetNumXSec(surf) >= before
assert vsp.GetXSec(surf, index)
`],
    ['invalid editable curve calls raise', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
# POD has a single section, so it cannot serve as the non-editable case.
wing = vsp.AddGeom('WING')
vsp.Update()
xsec = vsp.GetXSec(vsp.GetXSecSurf(wing, 0), 1)
for call in (lambda: vsp.GetEditXSecCtrlVec('missing'),
             lambda: vsp.MoveEditXSecPnt('missing', 0, (0.0, 0.0, 0.0))):
    try:
        call()
    except vsp.OpenVSPError:
        pass
    else:
        raise AssertionError('invalid XSec accepted')
# A non-editable section reports the native wrong-type error.
try:
    vsp.GetEditXSecCtrlVec(xsec)
except vsp.OpenVSPError:
    pass
else:
    raise AssertionError('non-editable section accepted')
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
