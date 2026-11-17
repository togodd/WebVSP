// Real Chromium/Python/WASM regression. From web/frontend:
// npm run dev -- --host 127.0.0.1 --port 5191 --strictPort
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=/path/to/chromium \
// WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/geom-edit-browser-check.mjs
// Use a disposable loopback page/model; intercept artifacts without replacing public files.
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
    ['types, main surfaces and reparenting', `
import openvsp as vsp
vsp.ClearVSPModel()
types = vsp.GetGeomTypes()
assert isinstance(types, (list, tuple)) and 'POD' in types and 'WING' in types, types
parent = vsp.AddGeom('WING')
other = vsp.AddGeom('POD')
child = vsp.AddGeom('POD', parent)
vsp.Update()
assert vsp.GetNumMainSurfs(parent) == 1
assert vsp.GetNumMainSurfs(child) == 1
assert vsp.GetGeomParent(child) == parent
assert child in vsp.GetGeomChildren(parent)
assert vsp.SetGeomParent(child, other) is None
assert vsp.GetGeomParent(child) == other
assert child in vsp.GetGeomChildren(other) and child not in vsp.GetGeomChildren(parent)
assert vsp.SetGeomParent(child, '') is None
assert vsp.GetGeomParent(child) == 'NONE'
assert child not in vsp.GetGeomChildren(other)
assert vsp.SetGeomParent(child, parent) is None
assert vsp.GetGeomParent(child) == parent
assert vsp.SetGeomParent(child, 'NONE') is None
assert vsp.GetGeomParent(child) == 'NONE'
`],
    ['clipboard snapshot, repeat paste and cut', `
import openvsp as vsp
vsp.ClearVSPModel()
parent = vsp.AddGeom('WING')
source = vsp.AddGeom('POD')
vsp.SetGeomName(source, 'ClipboardPod')
vsp.SetParmValUpdate(source, 'Length', 'Design', 4.0)
assert vsp.CopyGeomToClipboard(source) is None
vsp.SetParmValUpdate(source, 'Length', 'Design', 7.0)
first = vsp.PasteGeomClipboard(parent)
second = vsp.PasteGeomClipboard()
assert isinstance(first, (list, tuple)) and len(first) == 1, first
assert isinstance(second, (list, tuple)) and len(second) == 1, second
a, b = first[0], second[0]
assert len({source, a, b}) == 3
assert vsp.GetGeomParent(a) == parent and vsp.GetGeomParent(b) == 'NONE'
assert a in vsp.GetGeomChildren(parent)
for g in (a, b):
    assert vsp.GetGeomName(g) == 'ClipboardPod'
    assert vsp.GetGeomTypeName(g) == 'Pod'
    assert abs(vsp.GetParmVal(g, 'Length', 'Design') - 4.0) < 1e-6
assert abs(vsp.GetParmVal(source, 'Length', 'Design') - 7.0) < 1e-6
# Cutting replaces the prior copied snapshot; a paste receives a fresh ID.
assert vsp.CutGeomToClipboard(source) is None
assert source not in vsp.FindGeoms()
cut = vsp.PasteGeomClipboard(parent)
assert len(cut) == 1 and cut[0] not in (source, a, b)
c = cut[0]
assert vsp.GetGeomParent(c) == parent and c in vsp.GetGeomChildren(parent)
assert abs(vsp.GetParmVal(c, 'Length', 'Design') - 7.0) < 1e-6
again = vsp.PasteGeomClipboard()
assert len(again) == 1 and again[0] not in (source, a, b, c)
assert vsp.GetGeomParent(again[0]) == 'NONE'
assert abs(vsp.GetParmVal(again[0], 'Length', 'Design') - 7.0) < 1e-6
`],
    ['single-geometry update preserves child absolute placement', `
import openvsp as vsp
vsp.ClearVSPModel()
parent = vsp.AddGeom('POD')
child = vsp.AddGeom('POD', parent)
vsp.SetParmValUpdate(parent, 'X_Rel_Location', 'XForm', 3.0)
# ABS is 0 in native ABS_REL_FLAG. Set mode first, then set without a full update.
vsp.SetParmValUpdate(child, 'Abs_Or_Relitive_flag', 'XForm', 0)
vsp.SetParmVal(child, 'X_Location', 'XForm', 11.0)
assert vsp.UpdateGeom(child) is None
assert abs(vsp.GetParmVal(child, 'X_Location', 'XForm') - 11.0) < 1e-6
vsp.Update()
assert abs(vsp.GetParmVal(child, 'X_Location', 'XForm') - 11.0) < 1e-6
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
