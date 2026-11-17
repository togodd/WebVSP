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
    ['vector points, projection and curvature', `
import math
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()

def xyz(v):
    return (v.x(), v.y(), v.z())

def near(a, b, tol=1e-6):
    return all(abs(x - y) < tol for x, y in zip(a, b))

us = [0.1, 0.5, 0.9]
ws = [0.2, 0.5, 0.8]
points = vsp.CompVecPnt01(pod, 0, us, ws)
assert len(points) == 3, points
for u, w, point, single in zip(us, ws, points, [vsp.CompPnt01(pod, 0, u, w) for u, w in zip(us, ws)]):
    assert near(xyz(point), xyz(single)), (xyz(point), xyz(single))

normals = vsp.CompVecNorm01(pod, 0, us, ws)
assert len(normals) == 3
for u, w, normal, single in zip(us, ws, normals, [vsp.CompNorm01(pod, 0, u, w) for u, w in zip(us, ws)]):
    assert near(xyz(normal), xyz(single)), (xyz(normal), xyz(single))
    assert abs(math.sqrt(sum(c*c for c in xyz(normal))) - 1.0) < 1e-6

# A point one unit along the normal projects back to itself.
u, w = 0.3, 0.7
p = vsp.CompPnt01(pod, 0, u, w)
n = vsp.CompNorm01(pod, 0, u, w)
offset = (p.x() + n.x(), p.y() + n.y(), p.z() + n.z())
d, pu, pw = vsp.ProjPnt01(pod, 0, offset)
assert abs(d - 1.0) < 1e-6, d
assert abs(pu - u) < 1e-6 and abs(pw - w) < 1e-6, (pu, pw)

k1, k2, ka, kg = vsp.CompCurvature01(pod, 0, 0.25, 0.75)
assert abs(ka - 0.5 * (k1 + k2)) < 1e-9, (k1, k2, ka)
assert abs(kg - k1 * k2) < 1e-9, (k1, k2, kg)
assert kg > 0.0, kg

# Native returns the u samples and w samples separately; they need not be the
# same length (they are the mesh's u and w parameter sets).
tu, tw = vsp.GetUWTess01(pod, 0)
assert len(tu) > 4 and len(tw) > 4, (len(tu), len(tw))
assert all(0.0 <= v <= 1.0 for v in tu + tw)
`],
    ['invalid vector queries', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
# Mismatched lists are refused by the facade before any engine call.
try:
    vsp.CompVecPnt01(pod, 0, [0.5], [0.5, 0.6])
except ValueError:
    pass
else:
    raise AssertionError('mismatched u/w lists accepted')
for call in (
        lambda: vsp.CompVecNorm01('missing', 0, [0.5], [0.5]),
        lambda: vsp.ProjPnt01('missing', 0, (0.0, 0.0, 0.0)),
        lambda: vsp.CompCurvature01('missing', 0, 0.5, 0.5),
        lambda: vsp.GetUWTess01('missing', 0),
):
    try:
        call()
    except vsp.OpenVSPError:
        pass
    else:
        raise AssertionError('invalid surface query accepted')
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
