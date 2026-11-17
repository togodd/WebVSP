// Real Chromium/Python/WASM regression for the in-process analyses.
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... \
//   WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/analysis-expanded-browser-check.mjs
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
const errors = [], served = new Set(), failures = []
try {
  const page = await browser.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const request = new URL(route.request().url())
    if (request.origin !== url.origin) return route.abort()
    const match = request.pathname.match(/\/wasm\/(vsp\.js|vsp\.wasm)$/)
    if (match) {
      served.add(match[1])
      return route.fulfill({ status: 200, body: files[match[1]].body, headers: { 'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
    }
    return route.continue()
  })
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 60000 })
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)
  const analyses = [
    ['ParasiteDrag', 'Parasite_Drag'],
    ['WaveDrag', 'WaveDrag'],
    ['PlanarSlice', 'Slice'],
    ['Projection', 'Projection'],
    ['DegenGeomMesh', 'DegenGeomMesh'],
  ]
  // One session per analysis: each one mutates the model and they are not
  // meant to be chained in a single script.
  const cases = analyses.map(([analysis, result]) => [`${analysis} produces results`, `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('POD')
vsp.AddGeom('WING')
vsp.Update()
vsp.SetAnalysisInputDefaults('${analysis}')
root = vsp.ExecAnalysis('${analysis}')
assert root, '${analysis} returned no root result'
assert '${result}' in vsp.GetAllResultsNames(), vsp.GetAllResultsNames()[-6:]
# The result carries readable numeric data.
names = vsp.GetAllDataNames(root)
assert names, 'no data names on the ${analysis} result'
numeric = [n for n in names if vsp.GetResultsType(root, n) == vsp.DOUBLE_DATA]
assert numeric, names
series = vsp.GetDoubleResults(root, numeric[0], 0)
assert series, numeric[0]
`]).concat([
    ['parasite drag results are readable', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('POD')
vsp.Update()
vsp.SetAnalysisInputDefaults('ParasiteDrag')
root = vsp.ExecAnalysis('ParasiteDrag')
assert root
data = vsp.GetAllDataNames(root)
assert data, 'no data names on the parasite drag result'
values = {}
for name in data:
    # Only double fields hold numeric series; the drag report also has strings.
    if vsp.GetResultsType(root, name) != vsp.DOUBLE_DATA:
        continue
    series = vsp.GetDoubleResults(root, name, 0)
    if series:
        values[name] = series
assert values, data
for name, series in values.items():
    assert all(isinstance(v, (int, float)) for v in series), name
`],
    ['unsupported analyses still refuse', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('POD')
vsp.Update()
for name in ('CpSlicer', 'FeaMeshAnalysis', 'GeometryAnalysis', 'EmintonLord'):
    try:
        vsp.ExecAnalysis(name)
    except vsp.OpenVSPError as exc:
        assert 'Unknown analysis' in str(exc), (name, str(exc))
    else:
        raise AssertionError(name + ' should still be refused')
`],
    ['BladeElement reports the missing propeller', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('POD')
vsp.Update()
vsp.SetAnalysisInputDefaults('BladeElement')
try:
    vsp.ExecAnalysis('BladeElement')
except vsp.OpenVSPError:
    pass
else:
    raise AssertionError('BladeElement ran without a propeller')
`],
  ])
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
  if (failures.length) throw Error(failures.join('\n\n'))
} finally { await browser.close() }
