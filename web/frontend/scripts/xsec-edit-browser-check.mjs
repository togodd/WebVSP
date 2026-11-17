// Real Chromium/Python/WASM regression. From web/frontend:
// npm run dev -- --host 127.0.0.1 --port 5191 --strictPort
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=/path/to/chromium \
// WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/xsec-edit-browser-check.mjs
// Disposable loopback page/model only; intercept both build artifacts, never replace public files.
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
    ['dimensions and named parameters', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('STACK')
s = vsp.GetXSecSurf(g, 0)
vsp.ChangeXSecShape(s, 1, vsp.XS_ROUNDED_RECTANGLE)
vsp.ChangeXSecShape(s, 2, vsp.XS_ROUNDED_RECTANGLE)
vsp.Update()
a, b = vsp.GetXSec(s, 1), vsp.GetXSec(s, 2)
def near(a, b): assert abs(a-b) < 1e-6, (a,b)
vsp.SetXSecWidthHeight(a, 3.0, 6.0)
near(vsp.GetXSecWidth(a), 3.0)
near(vsp.GetXSecHeight(a), 6.0)
vsp.SetXSecWidthHeight(b, 1.5, 2.5)
near(vsp.GetXSecWidth(a), 3.0)
near(vsp.GetXSecHeight(a), 6.0)
vsp.SetXSecWidth(a, 4.0)
near(vsp.GetXSecWidth(a), 4.0)
near(vsp.GetXSecHeight(a), 6.0)
vsp.SetXSecHeight(a, 5.0)
near(vsp.GetXSecWidth(a), 4.0)
near(vsp.GetXSecHeight(a), 5.0)
near(vsp.GetXSecWidth(b), 1.5)
near(vsp.GetXSecHeight(b), 2.5)
p = vsp.GetXSecParm(a, 'RoundedRect_Width')
assert p and p in vsp.GetXSecParmIDs(a)
near(vsp.GetParmVal(p), 4.0)
vsp.SetParmVal(p, 3.25)
vsp.Update()
near(vsp.GetXSecWidth(a), 3.25)
for fn in (lambda: vsp.GetXSecWidth('missing'), lambda: vsp.GetXSecHeight('missing'),
           lambda: vsp.SetXSecWidth('missing', 1), lambda: vsp.SetXSecHeight('missing', 1),
           lambda: vsp.SetXSecWidthHeight('missing', 1, 2),
           lambda: vsp.GetXSecParm('missing', 'RoundedRect_Width'),
           lambda: vsp.GetXSecParm(a, 'missing_parm')):
    try: fn()
    except vsp.OpenVSPError: pass
    else: raise AssertionError('invalid XSec or parameter accepted')
near(vsp.GetXSecWidth(a), 3.25)
near(vsp.GetXSecHeight(b), 2.5)
`],
    ['clipboard: index and ID, snapshot, replacement and isolation', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('STACK')
h = vsp.AddGeom('STACK')
s, t = vsp.GetXSecSurf(g, 0), vsp.GetXSecSurf(h, 0)
vsp.ChangeXSecShape(s, 1, vsp.XS_ROUNDED_RECTANGLE)
vsp.Update()
source = vsp.GetXSec(s, 1)
vsp.SetXSecWidthHeight(source, 3.0, 4.0)
ids, other_ids = vsp.GetXSecIDs(s), vsp.GetXSecIDs(t)
assert len(ids) > 3 and len(other_ids) > 3
# The clipboard holds a snapshot, not a live reference.
vsp.CopyXSec(g, 1)
vsp.SetXSecWidthHeight(source, 5.0, 6.0)
vsp.PasteXSec(g, 3)
vsp.Update()
assert vsp.GetXSecIDs(s) == ids
assert vsp.GetXSecShape(ids[3]) == vsp.XS_ROUNDED_RECTANGLE
assert abs(vsp.GetXSecWidth(ids[3])-3.0) < 1e-6
assert abs(vsp.GetXSecHeight(ids[3])-4.0) < 1e-6
assert abs(vsp.GetXSecWidth(source)-5.0) < 1e-6
# Copy by ID and paste by ID on another geometry; clipboard remains reusable.
vsp.CopyXSecByID(source)
vsp.PasteXSecByID(other_ids[2])
vsp.PasteXSecByID(ids[2])
vsp.Update()
assert vsp.GetXSecIDs(s) == ids and vsp.GetXSecIDs(t) == other_ids
for target in (other_ids[2], ids[2]):
    assert vsp.GetXSecShape(target) == vsp.XS_ROUNDED_RECTANGLE
    assert abs(vsp.GetXSecWidth(target)-5.0) < 1e-6
    assert abs(vsp.GetXSecHeight(target)-6.0) < 1e-6
# The legacy and ID operations share the clipboard in both directions.
vsp.CopyXSecByID(ids[3])
vsp.PasteXSec(h, 3)
vsp.CopyXSec(g, 1)
vsp.PasteXSecByID(other_ids[1])
vsp.Update()
assert vsp.GetXSecIDs(t) == other_ids
assert abs(vsp.GetXSecWidth(other_ids[3])-3.0) < 1e-6
assert abs(vsp.GetXSecWidth(other_ids[1])-5.0) < 1e-6
`],
    ['invalid clipboard arguments do not mutate model or clipboard', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('STACK')
s = vsp.GetXSecSurf(g, 0)
vsp.ChangeXSecShape(s, 1, vsp.XS_ROUNDED_RECTANGLE)
vsp.Update()
ids = vsp.GetXSecIDs(s)
vsp.SetXSecWidthHeight(ids[1], 2.75, 4.25)
vsp.CopyXSec(g, 1)
for fn in (lambda: vsp.CopyXSec('missing', 1), lambda: vsp.PasteXSec('missing', 1),
           lambda: vsp.CopyXSec(g, -1), lambda: vsp.PasteXSec(g, -1),
           lambda: vsp.CopyXSec(g, len(ids)), lambda: vsp.PasteXSec(g, len(ids)),
           lambda: vsp.CopyXSecByID('missing'), lambda: vsp.PasteXSecByID('missing')):
    try: fn()
    except vsp.OpenVSPError: pass
    else: raise AssertionError('invalid clipboard argument accepted')
assert vsp.GetXSecIDs(s) == ids
vsp.PasteXSecByID(ids[2])
vsp.Update()
assert vsp.GetXSecIDs(s) == ids
assert vsp.GetXSecShape(ids[2]) == vsp.XS_ROUNDED_RECTANGLE
assert abs(vsp.GetXSecWidth(ids[2])-2.75) < 1e-6
assert abs(vsp.GetXSecHeight(ids[2])-4.25) < 1e-6
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
