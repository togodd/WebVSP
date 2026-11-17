// Real Chromium/Python/WASM regression for the planned surface-query API.
// From web/frontend, with a disposable loopback dev server and freshly built engine:
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=/path/to/chromium \
// WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/surface-query-browser-check.mjs
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
  catch (e) { throw Error(`Engine did not start: ${e.message}; page errors=${JSON.stringify(errors)}; blocked=${JSON.stringify(external)}; served=${JSON.stringify([...served])}; text=${await page.locator('body').innerText()}`) }
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)
  const cases = [
    ['display types, wire colour, material and bounding boxes', `
import math
import openvsp as vsp
vsp.ClearVSPModel()
geom = vsp.AddGeom('POD')
vsp.Update()

def xyz(v):
    return (v[0], v[1], v[2]) if isinstance(v, (list, tuple)) else (v.x(), v.y(), v.z())

draw_before = vsp.GetGeomDrawType(geom)
display_before = vsp.GetGeomDisplayType(geom)
colour_before = xyz(vsp.GetGeomWireColor(geom))
material_before = vsp.GetGeomMaterialName(geom)
assert isinstance(draw_before, int) and isinstance(display_before, int), (draw_before, display_before)
assert len(colour_before) == 3 and all(isinstance(c, (int, float)) for c in colour_before), colour_before
assert isinstance(material_before, str), material_before

# Draw types: 0 none, 1 wire, 2 hidden, 3 shade.
for value in (1, 2, 3, 0, 1):
    vsp.SetGeomDrawType(geom, value)
    assert vsp.GetGeomDrawType(geom) == value, (value, vsp.GetGeomDrawType(geom))
vsp.SetGeomDrawType(geom, draw_before)
assert vsp.GetGeomDrawType(geom) == draw_before

for value in (0, 1):
    vsp.SetGeomDisplayType(geom, value)
    assert vsp.GetGeomDisplayType(geom) == value
vsp.SetGeomDisplayType(geom, display_before)
assert vsp.GetGeomDisplayType(geom) == display_before

vsp.SetGeomWireColor(geom, (12, 34, 56))
assert xyz(vsp.GetGeomWireColor(geom)) == (12.0, 34.0, 56.0), xyz(vsp.GetGeomWireColor(geom))
vsp.SetGeomWireColor(geom, (255, 0, 128))
assert xyz(vsp.GetGeomWireColor(geom)) == (255.0, 0.0, 128.0)
vsp.SetGeomWireColor(geom, colour_before)
assert xyz(vsp.GetGeomWireColor(geom)) == colour_before

# This build registers no materials, so the getter works but every setter is
# refused by the native API. Keep that behaviour visible instead of hiding it.
for name in (material_before, 'NoSuchMaterial', ''):
    try:
        vsp.SetGeomMaterialName(geom, name)
    except vsp.OpenVSPError as exc:
        assert 'Material' in str(exc), exc
    else:
        raise AssertionError('material assigned without a registered material')
assert vsp.GetGeomMaterialName(geom) == material_before

lo, hi = xyz(vsp.GetGeomBBoxMin(geom)), xyz(vsp.GetGeomBBoxMax(geom))
assert all(math.isfinite(c) for c in lo + hi), (lo, hi)
assert all(a <= b + 1e-9 for a, b in zip(lo, hi)), (lo, hi)
# The absolute frame follows a location change; the relative frame does not.
rel_lo = xyz(vsp.GetGeomBBoxMin(geom, 0, False))
vsp.SetParmValUpdate(geom, 'X_Rel_Location', 'XForm', 5.0)
abs_lo = xyz(vsp.GetGeomBBoxMin(geom, 0, True))
assert abs(abs_lo[0] - lo[0] - 5.0) < 1e-6, (lo, abs_lo)
assert all(abs(a - b) < 1e-6 for a, b in zip(xyz(vsp.GetGeomBBoxMin(geom, 0, False)), rel_lo))
`],
    ['invalid geometry, colour and frame arguments', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('POD')
vsp.Update()
for call in (
        lambda: vsp.GetGeomDrawType('missing'),
        lambda: vsp.SetGeomDrawType('missing', 1),
        lambda: vsp.GetGeomDisplayType('missing'),
        lambda: vsp.SetGeomDisplayType('missing', 1),
        lambda: vsp.GetGeomWireColor('missing'),
        lambda: vsp.SetGeomWireColor('missing', (1, 2, 3)),
        lambda: vsp.GetGeomMaterialName('missing'),
        lambda: vsp.GetGeomBBoxMin('missing'),
        lambda: vsp.GetGeomBBoxMax('missing'),
        lambda: vsp.GetGeomBBoxMin(g, -1),
):
    try:
        call()
    except vsp.OpenVSPError:
        pass
    else:
        raise AssertionError('invalid geometry accepted')
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
