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
    ['parameter description, container and limits', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
parm = vsp.GetParm(pod, 'Length', 'Design')
assert parm, 'Length parameter missing'

desc_before = vsp.GetParmDescript(parm)
assert isinstance(desc_before, str)
container = vsp.GetParmContainer(parm)
assert isinstance(container, str) and container, container

vsp.SetParmDescript(parm, 'Manual geometry API length')
assert vsp.GetParmDescript(parm) == 'Manual geometry API length'
vsp.SetParmDescript(parm, desc_before)
assert vsp.GetParmDescript(parm) == desc_before

lower_before = vsp.GetParmLowerLimit(parm)
upper_before = vsp.GetParmUpperLimit(parm)
value_before = vsp.GetParmVal(parm)
actual = vsp.SetParmValLimits(parm, 0.5, 0.1, 0.9)
assert abs(actual - 0.5) < 1e-9, actual
assert abs(vsp.GetParmVal(parm) - 0.5) < 1e-9
# The new limits hold: a request below them is clamped by the native API.
vsp.SetParmVal(parm, -1.0)
assert abs(vsp.GetParmVal(parm) - 0.1) < 1e-9, vsp.GetParmVal(parm)
# Restore value and the original limits.
vsp.SetParmValLimits(parm, value_before, lower_before, upper_before)
assert abs(vsp.GetParmVal(parm) - value_before) < 1e-9
assert abs(vsp.GetParmLowerLimit(parm) - lower_before) < 1e-9
assert abs(vsp.GetParmUpperLimit(parm) - upper_before) < 1e-9
`],
    ['batch clone, batch delete and set copy', `
import openvsp as vsp
vsp.ClearVSPModel()
a = vsp.AddGeom('POD')
b = vsp.AddGeom('POD')
vsp.SetGeomName(a, 'BatchA')
vsp.SetGeomName(b, 'BatchB')
vsp.Update()

clones = vsp.CloneGeomVec([a, b], '_Copy')
assert isinstance(clones, (list, tuple)) and len(clones) == 2, clones
assert len({a, b, clones[0], clones[1]}) == 4
for source, clone in ((a, clones[0]), (b, clones[1])):
    # Native CloneGeomVec makes Clone-type geometries named after their source.
    assert vsp.GetGeomTypeName(clone) == 'Clone', vsp.GetGeomTypeName(clone)
    assert vsp.GetGeomName(clone) == vsp.GetGeomName(source) + '_Copy'
    assert vsp.GetGeomParent(clone) == vsp.GetGeomParent(source)

# Deleting a list removes exactly those geometries.
vsp.DeleteGeomVec(clones)
remaining = vsp.FindGeoms()
assert a in remaining and b in remaining
for clone in clones:
    assert clone not in remaining

# Set copy replaces the destination set's membership.
names = vsp.GetSetNames()
assert len(names) > 4
vsp.SetSetFlag(a, 3, True)
vsp.SetSetFlag(b, 3, False)
vsp.CopyPasteSet(3, 4)
assert a in vsp.GetGeomSetAtIndex(4)
assert b not in vsp.GetGeomSetAtIndex(4)
assert vsp.GetGeomSetCollection(3) == vsp.GetGeomSetCollection(3)
vsp.SetSetFlag(a, 3, False)
`],
    ['invalid parameter and batch arguments', `
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('POD')
vsp.Update()
for call in (
        lambda: vsp.GetParmDescript('missing'),
        lambda: vsp.SetParmDescript('missing', 'x'),
        lambda: vsp.GetParmContainer('missing'),
        lambda: vsp.CloneGeomVec(['missing']),
        lambda: vsp.DeleteGeomVec(['missing']),
):
    try:
        call()
    except vsp.OpenVSPError:
        pass
    else:
        raise AssertionError('invalid parameter or ID accepted')
# An empty ID list is refused by the facade before any engine call.
try:
    vsp.CloneGeomVec([])
except ValueError:
    pass
else:
    raise AssertionError('empty ID list accepted')
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
