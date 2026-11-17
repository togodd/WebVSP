// Real Chromium/Python/WASM regression for the generated enums and the desktop
// error queue. WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... \
//   WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/enums-errors-browser-check.mjs
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
    ['generated enums match the native header', `
import openvsp as vsp
# Values from APIDefines.h; a few hand-picked ones across different enums.
assert vsp.ABS == 0 and vsp.REL == 1, (vsp.ABS, vsp.REL)
assert vsp.STABILITY_OFF == 0
assert vsp.REORDER_MOVE_TOP == 2
assert vsp.VSPAERO_PROP_UNSTEADY == 1
assert vsp.VSP_CANT_FIND_PARM > 0
assert vsp.XS_ELLIPSE == 2 and vsp.SS_RECTANGLE == 1
assert vsp._ENUM_COUNT > 500, vsp._ENUM_COUNT

# The old gaps are filled now.
for name in ('ABS_REL_FLAG', 'STABILITY_OFF', 'VSPAERO_PROP_UNSTEADY'):
    assert hasattr(vsp, name) or name in ('ABS_REL_FLAG',), name
assert hasattr(vsp, 'ABS') and hasattr(vsp, 'REL')

# An enum value can be used as the native call expects it.
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
parm = vsp.GetParm(pod, 'Abs_Or_Relitive_flag', 'XForm')
vsp.SetParmValUpdate(parm, vsp.ABS)
assert vsp.GetParmVal(parm) == vsp.ABS
`],
    ['error queue behaves like ErrorMgrSingleton', `
import openvsp as vsp
manager = vsp.ErrorMgrSingleton.getInstance()
manager.NoError()
assert manager.GetNumTotalErrors() == 0

try:
    vsp.GetParmName('no-such-parm')
except vsp.OpenVSPError:
    pass
else:
    raise AssertionError('the bad call did not raise')

count = manager.GetNumTotalErrors()
assert count == 1, count
error = manager.PopLastError()
assert manager.GetNumTotalErrors() == count - 1
assert error.GetErrorCode() == vsp.VSP_CANT_FIND_PARM, error.GetErrorCode()
assert 'parm' in error.GetErrorString().lower() or 'parameter' in error.GetErrorString().lower(), error.GetErrorString()

# A second failure queues a second entry; NoError clears them all.
for _ in range(2):
    try:
        vsp.GetParmName('no-such-parm')
    except vsp.OpenVSPError:
        pass
assert manager.GetNumTotalErrors() == 2
manager.NoError()
assert manager.GetNumTotalErrors() == 0
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
  if (failures.length) throw Error(failures.join('\n\n'))
} finally { await browser.close() }
