// Real Chromium/Python/WASM regression for the scripting compatibility layer,
// the embedded custom components and the FEA builder defaults.
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
  const cases = [
    ['scripting shims behave like the AngelScript helpers', `
import openvsp as vsp
vsp.ClearVSPModel()
vsp.AddGeom('POD')
vsp.Update()

# Print: trailing bool controls the newline, like the scripts assume.
vsp.Print('value = ', False)
vsp.Print(1.5)
vsp.Print('joined:', ' a', 2, True)

# closeTo / CloseTo
assert vsp.closeTo(1.0, 1.0 + 1e-9) is True
assert vsp.closeTo(1.0, 1.1, 0.2) is True
assert vsp.CloseTo(1.0, 1.5) is False

# PrintResults walks every field of a result.
vsp.SetAnalysisInputDefaults('MassProp')
root = vsp.ExecAnalysis('MassProp')
vsp.PrintResults(root)

# Free-function error access still works.
assert isinstance(vsp.GetNumTotalErrors(), int)
`],
    ['embedded custom components are registered', `
import openvsp as vsp
vsp.ClearVSPModel()
types = vsp.GetGeomTypes()
for name in ('TransportFuse', 'Box', 'Disk', 'PodMan', 'Duct'):
    assert name in types, (name, types)

geom = vsp.AddGeom('TransportFuse', '')
vsp.Update()
assert vsp.GetGeomTypeName(geom) == 'TransportFuse'
assert len(vsp.GetGeomParmIDs(geom)) > 50
assert abs(vsp.GetParmVal(vsp.GetParm(geom, 'Length', 'Design')) - 10.0) < 1e-9
`],
    ['native default arguments are applied', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()

# AddFeaStruct(geom, init_skin=true, surfindex=0): only the geom is required.
index = vsp.AddFeaStruct(pod)
assert index == 0, index
part = vsp.AddFeaPart(pod, index, vsp.FEA_SLICE)
assert part, 'AddFeaPart returned nothing'
assert 'Struct' in vsp.GetFeaStructName(pod, index)

# Non-default call still works.
second = vsp.AddFeaStruct(pod, False)
assert second == 1, second
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
      console.log(`PASS ${name}`, result.stdout ? result.stdout.split('\n').slice(0, 3).join(' | ') : '')
    } catch (error) {
      failures.push(`${name}: ${error.stack || error}`)
      console.error(`FAIL ${name}:`, error.message)
    }
  }
  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors)}`)
  if (failures.length) throw Error(failures.join('\n\n'))
} finally { await browser.close() }
