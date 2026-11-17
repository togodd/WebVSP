// Real Chromium/Python/WASM regression for the in-process VSPAERO setup path.
// From web/frontend, with a disposable loopback dev server and a fresh engine:
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=/path/to/chromium \
// WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/vspaero-setup-browser-check.mjs
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
  catch (e) { throw Error(`Engine did not start: ${e.message}; page errors=${JSON.stringify(errors)}; blocked=${JSON.stringify(external)}; served=${JSON.stringify([...served])}`) }
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)
  const cases = [
    ['geometry export and setup files', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('WING')
vsp.Update()

# A fresh model is called Unnamed.vsp3 (relative), which would scatter the
# products in the engine cwd, so the bridge asks for an absolute workspace path.
assert vsp.GetVSPFileName() == 'Unnamed.vsp3', vsp.GetVSPFileName()
for call in (lambda: vsp.ExecAnalysis('VSPAEROComputeGeometry'), lambda: vsp.GetVSPAEROFiles()):
    try:
        call()
    except vsp.OpenVSPError as exc:
        assert 'SetVSP3FileName' in str(exc), exc
    else:
        raise AssertionError('VSPAERO accepted a relative model name')

vsp.SetVSP3FileName('/work/case.vsp3')
before = {entry['path']: entry for entry in vsp.GetVSPAEROFiles()}
assert before['/work/case.vspgeom']['exists'] is False, before
assert before['/work/case.vspgeom']['size'] == -1

vsp.SetAnalysisInputDefaults('VSPAEROComputeGeometry')
root = vsp.ExecAnalysis('VSPAEROComputeGeometry')
assert root, 'VSPAEROComputeGeometry returned no result'

after = {entry['path']: entry for entry in vsp.GetVSPAEROFiles()}
assert after['/work/case.vspgeom']['exists'] is True, after
assert after['/work/case.vspgeom']['size'] > 1000, after
assert after['/work/case.history']['exists'] is False, after
`],
    ['stop before run writes the setup without a solver run', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('WING')
vsp.Update()
vsp.SetVSP3FileName('/work/setup.vsp3')
vsp.SetAnalysisInputDefaults('VSPAEROComputeGeometry')
vsp.ExecAnalysis('VSPAEROComputeGeometry')

vsp.SetAnalysisInputDefaults('VSPAEROSweep')
vsp.SetIntAnalysisInput('VSPAEROSweep', 'StopBeforeRun', [1])
vsp.SetIntAnalysisInput('VSPAEROSweep', 'NCPU', [1])
root = vsp.ExecAnalysis('VSPAEROSweep')
assert root == '', root

files = {entry['path']: entry for entry in vsp.GetVSPAEROFiles()}
assert files['/work/setup.vspaero']['exists'] is True, files
assert files['/work/setup.vspaero']['size'] > 100, files
# No solver ran, so no solution products exist.
assert files['/work/setup.history']['exists'] is False, files
assert files['/work/setup.polar']['exists'] is False, files
`],
    ['full solver run produces history, polar and results', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('WING')
vsp.Update()
vsp.SetVSP3FileName('/work/run.vsp3')

vsp.SetAnalysisInputDefaults('VSPAEROComputeGeometry')
vsp.ExecAnalysis('VSPAEROComputeGeometry')

vsp.SetAnalysisInputDefaults('VSPAEROSweep')
for name, value in (('AlphaStart', 4.0), ('AlphaEnd', 4.0), ('BetaStart', 0.0),
                    ('BetaEnd', 0.0), ('MachStart', 0.1), ('MachEnd', 0.1)):
    vsp.SetDoubleAnalysisInput('VSPAEROSweep', name, [value])
for name, value in (('AlphaNpts', 1), ('BetaNpts', 1), ('MachNpts', 1), ('ReCrefNpts', 1), ('NCPU', 1)):
    vsp.SetIntAnalysisInput('VSPAEROSweep', name, [value])

root = vsp.ExecAnalysis('VSPAEROSweep')
assert root, 'VSPAEROSweep returned no result'

files = {entry['path']: entry for entry in vsp.GetVSPAEROFiles()}
for suffix in ('.vspgeom', '.vspaero', '.history', '.polar', '.lod'):
    assert files['/work/run' + suffix]['exists'] is True, (suffix, files)
assert files['/work/run.history']['size'] > 100, files

history = vsp.FindResultsID('VSPAERO_History', 0)
assert history, vsp.GetAllResultsNames()[-5:]
names = vsp.GetAllDataNames(history)
assert 'Alpha' in names and 'CDtot' in names, names
alpha = vsp.GetDoubleResults(history, 'Alpha', 0)
cdtot = vsp.GetDoubleResults(history, 'CDtot', 0)
assert alpha and len(alpha) == len(cdtot), (alpha, cdtot)
# The history holds one entry per solver case; the requested 4 degree alpha
# reached VSPAERO, which is the part the Python inputs control.
assert all(abs(a - 4.0) < 1e-9 for a in alpha), alpha
assert all(c > 0.0 for c in cdtot), cdtot

# The solver's own output is available to Python after the run.
output = vsp.GetVSPAEROOutput()
assert len(output) > 50, output[:200]
assert 'Done' in output, output[:200]
# The solver's own banner and setup lines are part of that tail.
assert 'VSPAERO' in output or 'vortex' in output, output[:300]
`],
    ['reference wing, modes and control surface groups', `
import openvsp as vsp
vsp.ClearVSPModel()
wing = vsp.AddGeom('WING')
vsp.SetGeomName(wing, 'MainWing')
vsp.Update()
vsp.SetVSP3FileName('/work/refs.vsp3')

# The engine points VSPAERO at its own program directory.
assert vsp.GetVSPAEROPath() == '/bin', vsp.GetVSPAEROPath()

# No mode is selected on a fresh model, and an unknown mode is refused natively.
assert vsp.GetVSPAEROModeID() == '', vsp.GetVSPAEROModeID()
assert vsp.GetVSPAEROCGModeID() == '', vsp.GetVSPAEROCGModeID()
for call in (lambda: vsp.SetVSPAEROModeID('mode-1'), lambda: vsp.SetVSPAEROCGModeID('mode-1')):
    try:
        call()
    except vsp.OpenVSPError as exc:
        assert 'Mode' in str(exc), exc
    else:
        raise AssertionError('unknown mode accepted')

# The reference wing round trips through the native setter.
assert vsp.SetVSPAERORefWingID(wing) == wing
assert vsp.GetVSPAERORefWingID() == wing

# Control surface groups: create, rename, fill, empty, auto group and delete.
group = vsp.AddVSPAEROControlSurfaceGroup()
assert group, group
assert vsp.GetVSPAEROControlGroupName(0) == 'Unnamed Control Group'
vsp.SetVSPAEROControlGroupName('Aileron', 0)
assert vsp.GetVSPAEROControlGroupName(0) == 'Aileron'
vsp.AddAllToVSPAEROControlSurfaceGroup(0)
vsp.RemoveAllFromVSPAEROControlSurfaceGroup(0)
vsp.AutoGroupVSPAEROControlSurfaces()
vsp.DeleteVSPAEROControlSurfaceGroup(0)
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
