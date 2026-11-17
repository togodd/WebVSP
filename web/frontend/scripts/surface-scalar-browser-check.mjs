// Real Chromium/Python/WASM regression for the surface-query scalar family.
// From web/frontend with a disposable loopback dev server:
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine \
//   node scripts/surface-scalar-browser-check.mjs
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
  catch (e) { throw Error(`Engine did not start: ${e.message}; page errors=${JSON.stringify(errors)}`) }
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)
  const cases = [
    ['tangents, RST conversion and inside tests', `
import math
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()

def xyz(v):
    return (v.x(), v.y(), v.z())

u, w = 0.3, 0.7
# Native tangents are surface derivatives, not unit vectors.
tangent_u = vsp.CompTanU01(pod, 0, u, w)
tangent_w = vsp.CompTanW01(pod, 0, u, w)
assert all(math.isfinite(c) for c in xyz(tangent_u) + xyz(tangent_w))
assert math.sqrt(sum(c*c for c in xyz(tangent_u))) > 1e-6
# Tangents follow a surface step; compare against a finite difference.
h = 1e-4
p0 = vsp.CompPnt01(pod, 0, u, w)
p1 = vsp.CompPnt01(pod, 0, u + h, w)
step = ((p1.x() - p0.x()) / h, (p1.y() - p0.y()) / h, (p1.z() - p0.z()) / h)
norm = math.sqrt(sum(c*c for c in step))
cos = sum(a*b for a, b in zip(xyz(tangent_u), step)) / norm
assert cos > 0.99, cos

# RST point and its LMN conversion round trip.
rst = vsp.CompPntRST(pod, 0, 0.5, 0.5, 0.5)
assert all(math.isfinite(c) for c in xyz(rst)), xyz(rst)
lmn = vsp.ConvertRSTtoLMN(pod, 0, 0.5, 0.5, 0.5)
back = vsp.ConvertLMNtoRST(pod, 0, lmn[0], lmn[1], lmn[2])
assert len(lmn) == 3 and len(back) == 3
assert all(abs(a-b) < 1e-6 for a, b in zip(back, (0.5, 0.5, 0.5))), back

# A surface point is on the boundary, its centre is inside.
on_surface = vsp.CompPnt01(pod, 0, 0.5, 0.5)
assert vsp.InsideSurf(pod, 0, xyz(on_surface)) in (True, False)
# The geometric centre comes from the bounding box, not from the origin.
lo, hi = vsp.GetGeomBBoxMin(pod), vsp.GetGeomBBoxMax(pod)
centre = ((lo.x() + hi.x()) / 2, (lo.y() + hi.y()) / 2, (lo.z() + hi.z()) / 2)
assert vsp.InsideSurf(pod, 0, centre) is True, centre
`],
    ['projections and RST search', `
import math
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()

u, w = 0.3, 0.7
p = vsp.CompPnt01(pod, 0, u, w)
n = vsp.CompNorm01(pod, 0, u, w)
offset = (p.x() + n.x(), p.y() + n.y(), p.z() + n.z())

d, pu, pw = vsp.ProjPnt01(pod, 0, offset)
assert abs(d - 1.0) < 1e-6, d
gd, gu, gw = vsp.ProjPnt01Guess(pod, 0, offset, 0.5, 0.5)
assert abs(gd - 1.0) < 1e-6, gd
# A closed body can have more than one nearest point at the same distance, so
# check that the result really sits one unit from the offset point.
guess_point = vsp.CompPnt01(pod, 0, gu, gw)
sep = math.sqrt(sum((a - b) ** 2 for a, b in zip(
    (guess_point.x(), guess_point.y(), guess_point.z()), offset)))
assert abs(sep - 1.0) < 1e-6, sep

id_, surf, iu, iw = vsp.ProjPnt01I(pod, offset)
assert surf == 0 and abs(id_ - 1.0) < 1e-6, (id_, surf)
ad, au, aw = vsp.AxisProjPnt01(pod, 0, 2, (0.0, 0.0, 10.0))
assert math.isfinite(ad) and 0.0 <= au <= 1.0 and 0.0 <= aw <= 1.0, (ad, au, aw)
aid, asurf, aiu, aiw = vsp.AxisProjPnt01I(pod, (0.0, 0.0, 10.0), 2)
assert asurf == 0 and math.isfinite(aid), (aid, asurf)

surface_point = (p.x(), p.y(), p.z())
rd, r, s, t = vsp.FindRST(pod, 0, surface_point)
assert rd < 1e-6, rd
# RST is not the (u, w) parameterisation: check it rebuilds the same point.
rebuilt = vsp.CompPntRST(pod, 0, r, s, t)
assert math.sqrt(sum((a - b) ** 2 for a, b in zip(
    (rebuilt.x(), rebuilt.y(), rebuilt.z()), surface_point))) < 1e-6
gd2, gr, gs, gt = vsp.FindRSTGuess(pod, 0, surface_point, 0.4, 0.4, 0.5)
assert gd2 < 1e-6, gd2

# Comparing a geometry with itself has no deviation.
assert abs(vsp.CompareGeomSurfaces(pod, pod)) < 1e-12
`],
    ['invalid surface queries raise', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
for call in (
        lambda: vsp.CompTanU01('missing', 0, 0.5, 0.5),
        lambda: vsp.CompPntRST('missing', 0, 0.5, 0.5, 0.5),
        lambda: vsp.ProjPnt01Guess('missing', 0, (0.0, 0.0, 0.0), 0.5, 0.5),
        lambda: vsp.FindRST('missing', 0, (0.0, 0.0, 0.0)),
        lambda: vsp.CompareGeomSurfaces(pod, 'missing'),
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
