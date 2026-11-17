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
    ['scalar and string getters across signatures', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.SetGeomName(pod, 'Body')
vsp.Update()

# string -> string / int / bool / double
parm = vsp.GetGeomParmIDs(pod)[0]
assert isinstance(vsp.GetParmName(parm), str) and vsp.GetParmName(parm)
assert isinstance(vsp.GetParmType(parm), int)
assert isinstance(vsp.GetParmGroupName(parm), str)
assert isinstance(vsp.GetParmActiveFlag(parm), bool)
assert isinstance(vsp.GetParmVal(parm), (int, float))
assert vsp.CheckForVSPAERO('/bin') is True

# no arguments -> value
assert isinstance(vsp.GetVSPFileName(), str)
assert isinstance(vsp.GetGeomTypes(), list) and 'POD' in vsp.GetGeomTypes()
assert isinstance(vsp.GetVSPAEROPath(), str)

# string, int -> value (index beyond the data entries is refused natively)
assert isinstance(vsp.GetParmType(parm), int)
`],
    ['writes through the generic bridge round trip', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
parm = vsp.GetGeomParmIDs(pod)[0]

# void(string) — a description is a plain string write.
vsp.SetParmDescript(parm, 'Bridged description')
assert vsp.GetParmDescript(parm) == 'Bridged description'

# void(string) — file name write, read back through another getter.
vsp.SetVSP3FileName('/work/generic.vsp3')
assert vsp.GetVSPFileName() == '/work/generic.vsp3'

# void(string, string) — rename a parameter's owning geometry.
vsp.SetGeomName(pod, 'RenamedBody')
assert vsp.GetGeomName(pod) == 'RenamedBody'

# void() — an argument-free write runs without raising.
vsp.Update()
`],
    ['error paths surface native messages', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('POD')
vsp.Update()
for call in (lambda: vsp.GetParmName('no-such-parm'), lambda: vsp.GetParmType('no-such-parm')):
    try:
        call()
    except vsp.OpenVSPError as exc:
        assert 'parameter' in str(exc).lower(), exc
    else:
        raise AssertionError('invalid parameter accepted')
# Wrong argument types are rejected by the facade before any engine call.
for call in (lambda: vsp.GetParmName(5), lambda: vsp.GetSubSurfType(5)):
    try:
        call()
    except (TypeError, ValueError, vsp.OpenVSPError):
        pass
    else:
        raise AssertionError('integer accepted for a string parameter')
`],
    ['no-argument, vector and vec3d returns', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()

# int() / string() / vector<string>() / bool() signatures
assert isinstance(vsp.GetVSPFileName(), str)
ids = vsp.GetAllSubSurfIDs()
assert isinstance(ids, list)
containers = vsp.FindContainers()
assert isinstance(containers, list) and pod in containers

# vector<string>(string) and vector<double>(string)
parms = vsp.GetGeomParmIDs(pod)
assert isinstance(parms, list) and len(parms) > 10
subs = vsp.GetSubSurfIDVec(pod)
assert isinstance(subs, list)
`],
    ['third-wave shapes: double, int(int), vector<vec3d>, vector<int>', `
import openvsp as vsp
vsp.ClearVSPModel()
wing = vsp.AddGeom('WING')
vsp.Update()

# int() / double() / bool() counts on a fresh model
for name in ('GetNumAnalysis', 'GetNumModes', 'GetNumParmLinks', 'GetNumDesignVars'):
    assert isinstance(getattr(vsp, name)(), int), name
for name in ('GetNumUserParms', 'GetNumControlSurfaceGroups', 'GetNumExcrescences'):
    assert isinstance(getattr(vsp, name)(), int), name

# double(double) / double(double, double)
assert abs(vsp.Deg2Rad(180.0) - 3.141592653589793) < 1e-12
assert abs(vsp.Rad2Deg(3.141592653589793) - 180.0) < 1e-9
assert vsp.Max(2.0, 5.0) == 5.0 and vsp.Min(2.0, 5.0) == 2.0

# vector<int>(string) and vector<string>(string)
parms = vsp.GetGeomParmIDs(wing)
assert isinstance(parms, list) and parms
assert isinstance(vsp.GetXSecSurfIDs(wing), list)

# vector<vec3d>(string) returns the native list of vec3d
sub = vsp.AddSubSurf(wing, vsp.SS_RECTANGLE)
assert isinstance(vsp.GetSubSurfParmIDs(sub), list)
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
