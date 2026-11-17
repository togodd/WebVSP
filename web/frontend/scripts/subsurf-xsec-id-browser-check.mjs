// Real Chromium/Python/WASM regression. From web/frontend:
// npm run dev -- --host 127.0.0.1 --port 5191 --strictPort
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=/path/to/chromium \
// WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/subsurf-xsec-id-browser-check.mjs
// A disposable page/model is required. Interception replaces both WASM files, never public artifacts.
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
const manual = await readFile('scripts/manual-geometry-api.py', 'utf8')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const errors = [], external = [], served = new Set(), failures = []
try {
  const page = await browser.newPage()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console ${msg.type()}: ${msg.text()}`) })
  page.on('requestfailed', req => { if (req.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`request failed: ${req.url()} ${req.failure()?.errorText}`) })
  await page.route('**/*', async route => {
    const request = new URL(route.request().url())
    if (request.origin !== url.origin) { external.push(request.href); return route.abort() }
    const match = request.pathname.match(/\/wasm\/(vsp\.js|vsp\.wasm)$/)
    if (match) {
      const file = files[match[1]]
      served.add(match[1])
      return route.fulfill({ status: 200, body: file.body, headers: { 'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
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
    ['SubSurf name / order / type / parameters', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('FUSELAGE')
other = vsp.AddGeom('FUSELAGE')
a = vsp.AddSubSurf(g, vsp.SS_RECTANGLE)
b = vsp.AddSubSurf(g, vsp.SS_LINE)
c = vsp.AddSubSurf(g, vsp.SS_RECTANGLE)
assert vsp.GetSubSurfIDVec(g) == [a,b,c]
assert vsp.GetNumSubSurf(g) == 3
assert [vsp.GetSubSurf(g,i) for i in range(3)] == [a,b,c]
assert [vsp.GetSubSurfType(x) for x in (a,b,c)] == [vsp.SS_RECTANGLE,vsp.SS_LINE,vsp.SS_RECTANGLE]
vsp.SetSubSurfName(a, 'Shared')
vsp.SetSubSurfName(g, b, 'Shared')
vsp.SetSubSurfName(g, c, 'Third')
assert vsp.GetSubSurfName(a) == vsp.GetSubSurfName(g,a) == 'Shared'
assert vsp.GetSubSurfName(b) == 'Shared'
assert set(vsp.GetSubSurf(g, 'Shared')) == {a,b}
try:
    vsp.GetSubSurf(g, 'absent')
except vsp.OpenVSPError:
    pass
else:
    raise AssertionError('unknown subsurface name accepted')
assert {a,b,c}.issubset(set(vsp.GetAllSubSurfIDs()))
vsp.ReorderSubSurf(g,c,vsp.REORDER_MOVE_TOP)
assert vsp.GetSubSurfIDVec(g) == [c,a,b]
assert [vsp.GetSubSurfIndex(x) for x in (c,a,b)] == [0,1,2]
vsp.ReorderSubSurf(g,c,vsp.REORDER_MOVE_BOTTOM)
assert vsp.GetSubSurfIDVec(g) == [a,b,c]
vsp.ReorderSubSurf(g,b,vsp.REORDER_MOVE_UP)
assert vsp.GetSubSurfIDVec(g) == [b,a,c]
vsp.ReorderSubSurf(g,b,vsp.REORDER_MOVE_DOWN)
assert vsp.GetSubSurfIDVec(g) == [a,b,c]
for sub in (a,b,c):
    ids = vsp.GetSubSurfParmIDs(sub)
    assert ids and len(ids) == len(set(ids))
    info = vsp.GetParmInfo(ids[0])
    assert info['name'] and isinstance(info['value'], (int,float))
try:
    vsp.GetSubSurfName(other,a)
except vsp.OpenVSPError:
    pass
else:
    raise AssertionError('wrong owner must fail')
assert vsp.GetSubSurfIDVec(g) == [a,b,c]
vsp.DeleteSubSurf(a)
vsp.DeleteSubSurf(g,b)
assert vsp.GetSubSurfIDVec(g) == [c]
assert a not in vsp.GetAllSubSurfIDs() and b not in vsp.GetAllSubSurfIDs()
`],
    ['XSec ID lists and insertion/deletion', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('FUSELAGE')
surfs = vsp.GetXSecSurfIDs(g)
assert surfs and len(surfs) == vsp.GetNumXSecSurfs(g)
assert surfs[0] == vsp.GetXSecSurf(g,0)
s = surfs[0]
before = vsp.GetXSecIDVec(s)
assert before == vsp.GetXSecIDs(s)
assert len(before) > 2 and before == [vsp.GetXSec(s,i) for i in range(vsp.GetNumXSec(s))]
inserted = vsp.InsertXSecByID(before[1], vsp.XS_ELLIPSE)
after = vsp.GetXSecIDs(s)
assert inserted and inserted not in before and len(after) == len(before)+1
assert after == before[:2] + [inserted] + before[2:]
assert vsp.GetXSecShape(inserted) == vsp.XS_ELLIPSE
assert vsp.GetXSecParmIDs(inserted)
vsp.CutXSecByID(inserted)
assert vsp.GetXSecIDs(s) == before
for fn in (lambda: vsp.GetXSecIDs('missing'), lambda: vsp.InsertXSecByID('missing',vsp.XS_ELLIPSE), lambda: vsp.CutXSecByID('missing')):
    try: fn()
    except vsp.OpenVSPError: pass
    else: raise AssertionError('invalid XSec ID accepted')
assert vsp.GetXSecIDs(s) == before
`],
    ['Set legacy API regression', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('FUSELAGE')
h = vsp.AddGeom('POD')
names = vsp.GetSetNames()
assert len(names) == vsp.GetNumSets() and len(names) > 3
idx = 3
old = vsp.GetSetName(idx)
vsp.SetSetName(idx,'RegressionSet')
assert vsp.GetSetIndex('RegressionSet') == idx and vsp.GetSetName(idx) == 'RegressionSet'
vsp.SetSetFlag(g,idx,True)
vsp.SetSetFlag(h,idx,False)
assert vsp.GetSetFlag(g,idx) and not vsp.GetSetFlag(h,idx)
assert g in vsp.GetGeomSet('RegressionSet') and h not in vsp.GetGeomSet('RegressionSet')
assert vsp.GetGeomSet('RegressionSet') == vsp.GetGeomSetAtIndex(idx)
vsp.SetSetFlag(g,idx,False)
assert not vsp.GetSetFlag(g,idx) and g not in vsp.GetGeomSetAtIndex(idx)
vsp.SetSetName(idx,old)
`],
    ['Existing manual geometry script', manual],
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
