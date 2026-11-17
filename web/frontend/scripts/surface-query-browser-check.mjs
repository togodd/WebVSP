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
    ['FUSELAGE and WING surface coordinates', `
import math
import openvsp as vsp
vsp.ClearVSPModel()
fuselage = vsp.AddGeom('FUSELAGE')
wing = vsp.AddGeom('WING')
vsp.Update()

def xyz(v):
    # Native Python returns vec3d, not a list or a JSON object.
    values = (v.x(), v.y(), v.z())
    assert all(isinstance(x, (int, float)) and math.isfinite(x) for x in values), values
    return values

def distance(a, b):
    return math.sqrt(sum((x-y)**2 for x, y in zip(a, b)))

def near(a, b, tol=1e-6):
    assert distance(a, b) < tol, (a, b)

for geom in (fuselage, wing):
    count = vsp.GetNumMainSurfs(geom)
    assert isinstance(count, int) and count == 1, (geom, count)
    # Include both ends and middle of each normalized parameter; avoid assuming
    # linear interpolation of a curved surface or a particular orientation.
    points = {(u, w): xyz(vsp.CompPnt01(geom, 0, u, w))
              for u in (0.0, 0.5, 1.0) for w in (0.0, 0.5, 1.0)}
    assert distance(points[(0.0, 0.5)], points[(1.0, 0.5)]) > 1e-4, points
    assert distance(points[(0.5, 0.0)], points[(0.5, 0.5)]) > 1e-4, points
    # Closed cross-section seam, also exercised by the native API examples.
    near(points[(0.5, 0.0)], points[(0.5, 1.0)])
    # Native clamps both coordinates to [0, 1].
    near(xyz(vsp.CompPnt01(geom, 0, -0.5, 1.5)), points[(0.0, 1.0)])
    normal = xyz(vsp.CompNorm01(geom, 0, 0.37, 0.23))
    assert abs(math.sqrt(sum(x*x for x in normal)) - 1.0) < 1e-6, normal
    for u, w in ((0.0, 0.0), (0.5, 0.5), (1.0, 1.0)):
        xyz(vsp.CompNorm01(geom, 0, u, w))  # boundary normals can be degenerate
    before = xyz(vsp.CompPnt01(geom, 0, 0.37, 0.23))
    vsp.SetParmValUpdate(geom, 'X_Rel_Location', 'XForm', 3.0)
    after = xyz(vsp.CompPnt01(geom, 0, 0.37, 0.23))
    near(after, (before[0] + 3.0, before[1], before[2]))
    near(xyz(vsp.CompNorm01(geom, 0, 0.37, 0.23)), normal)
`],
    ['invalid geometry and surface index', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('FUSELAGE')
vsp.Update()
for fn in (lambda: vsp.GetNumMainSurfs('no-such-geom'),
           lambda: vsp.CompPnt01('no-such-geom', 0, 0.5, 0.5),
           lambda: vsp.CompNorm01('no-such-geom', 0, 0.5, 0.5),
           lambda: vsp.CompPnt01(g, -1, 0.5, 0.5),
           lambda: vsp.CompNorm01(g, -1, 0.5, 0.5)):
    try: fn()
    except vsp.OpenVSPError: pass
    else: raise AssertionError('invalid geometry or surface index accepted')
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
