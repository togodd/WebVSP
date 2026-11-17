// Native-shaped analysis-input round trips against the live engine; no analysis is executed.
//   WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/analysis-input-browser-check.mjs
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
const failures = [], served = new Set()
try {
  const page = await browser.newPage()
  const errors = [], external = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/*', async (route) => {
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
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__runPython === 'function')
  for (const name of ['vsp.js', 'vsp.wasm']) {
    if (!served.has(name)) throw Error(`Expected intercepted ${name} was not served`)
    console.log(`${name} served from ${files[name].path} sha256 ${files[name].hash}`)
  }

  const r = await page.evaluate(() => window.__runPython(String.raw`
import json, openvsp as vsp

# Inputs are saved without resetting all defaults, and restored even after an assertion.
# ParasiteDrag is never executed: only its actual Vinf input is read and written.
mode_before = list(vsp.GetStringAnalysisInput('MassProp', 'ModeID'))
vinf_before = list(vsp.GetDoubleAnalysisInput('ParasiteDrag', 'Vinf'))
set_before = list(vsp.GetIntAnalysisInput('MassProp', 'Set'))
assert set_before == list(vsp.GetIntAnalysisInput('MassProp', 'Set', 0))
assert len(set_before) == 1 and isinstance(set_before[0], int)

checks = []
def rejects(label, call):
    try:
        call()
    except Exception:
        checks.append(label)
    else:
        raise AssertionError(label + ' unexpectedly succeeded')

try:
    for values in ([123.5], [-1.25]):
        vsp.SetDoubleAnalysisInput('ParasiteDrag', 'Vinf', values)
        assert list(vsp.GetDoubleAnalysisInput('ParasiteDrag', 'Vinf')) == values
        assert list(vsp.GetDoubleAnalysisInput('ParasiteDrag', 'Vinf', 0)) == values
    vsp.SetDoubleAnalysisInput('ParasiteDrag', 'Vinf', [3.5], 0)
    assert list(vsp.GetDoubleAnalysisInput('ParasiteDrag', 'Vinf')) == [3.5]

    for values in (['mode-test'], [''], ['中文 😀'], ['quote " and newline\nnext']):
        vsp.SetStringAnalysisInput('MassProp', 'ModeID', values)
        assert list(vsp.GetStringAnalysisInput('MassProp', 'ModeID')) == values
        assert list(vsp.GetStringAnalysisInput('MassProp', 'ModeID', 0)) == values
    vsp.SetStringAnalysisInput('MassProp', 'ModeID', ['explicit'], 0)
    assert list(vsp.GetStringAnalysisInput('MassProp', 'ModeID')) == ['explicit']

    # The current setters deliberately accept only one element and index zero.
    rejects('empty double vector', lambda: vsp.SetDoubleAnalysisInput('ParasiteDrag', 'Vinf', []))
    rejects('multiple doubles', lambda: vsp.SetDoubleAnalysisInput('ParasiteDrag', 'Vinf', [1.0, 2.0]))
    rejects('empty string vector', lambda: vsp.SetStringAnalysisInput('MassProp', 'ModeID', []))
    rejects('multiple strings', lambda: vsp.SetStringAnalysisInput('MassProp', 'ModeID', ['a', 'b']))

    # Index identifies an existing same-name data entry, not a vector element.
    rejects('int index 1', lambda: vsp.GetIntAnalysisInput('MassProp', 'Set', 1))
    rejects('double index 1', lambda: vsp.GetDoubleAnalysisInput('ParasiteDrag', 'Vinf', 1))
    rejects('string index 1', lambda: vsp.GetStringAnalysisInput('MassProp', 'ModeID', 1))
    rejects('negative index', lambda: vsp.GetStringAnalysisInput('MassProp', 'ModeID', -1))
    rejects('double setter index 1', lambda: vsp.SetDoubleAnalysisInput('ParasiteDrag', 'Vinf', [99.0], 1))
    rejects('string setter index 1', lambda: vsp.SetStringAnalysisInput('MassProp', 'ModeID', ['bad'], 1))
    rejects('wrong double input type', lambda: vsp.SetDoubleAnalysisInput('MassProp', 'Set', [1.0]))
    rejects('wrong string input type', lambda: vsp.SetStringAnalysisInput('MassProp', 'Set', ['bad']))
    rejects('unknown input', lambda: vsp.GetStringAnalysisInput('MassProp', 'NoSuchInput'))
    assert list(vsp.GetDoubleAnalysisInput('ParasiteDrag', 'Vinf')) == [3.5]
    assert list(vsp.GetStringAnalysisInput('MassProp', 'ModeID')) == ['explicit']
    assert list(vsp.GetIntAnalysisInput('MassProp', 'Set')) == set_before
finally:
    # Separate finally blocks ensure that a failed string restore does not skip double restore.
    try:
        vsp.SetStringAnalysisInput('MassProp', 'ModeID', mode_before)
    finally:
        vsp.SetDoubleAnalysisInput('ParasiteDrag', 'Vinf', vinf_before)

assert list(vsp.GetStringAnalysisInput('MassProp', 'ModeID')) == mode_before
assert list(vsp.GetDoubleAnalysisInput('ParasiteDrag', 'Vinf')) == vinf_before
json.dumps({'checks': checks, 'restored': True})
`))
  const v = typeof r === 'string' ? JSON.parse(r) : r
  if (!v?.restored || v.checks?.length !== 13) failures.push(`analysis input checks: ${JSON.stringify(v)}`)
  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS analysis input getters/setters and restoration')
} finally { await browser.close() }
