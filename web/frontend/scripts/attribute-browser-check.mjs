// Real Chromium/Python/WASM regression for the attribute API.
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine \
//   node scripts/attribute-browser-check.mjs
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
  catch (e) { throw Error(`Engine did not start: ${e.message}; page errors=${JSON.stringify(errors)}`) }
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)
  const cases = [
    ['scalar, vec3d and matrix attributes round trip', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()

# Each object owns a child attribute collection.
coll = vsp.GetChildCollection(pod)
assert coll, 'geometry has no attribute collection'
bool_id = vsp.AddAttributeBool(coll, 'Flag', True)
int_id = vsp.AddAttributeInt(coll, 'Count', 7)
double_id = vsp.AddAttributeDouble(coll, 'Mass', 12.5)
string_id = vsp.AddAttributeString(coll, 'Label', 'Body')
vec_id = vsp.AddAttributeVec3d(coll, 'Anchor', [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)])
int_mat = vsp.AddAttributeIntMatrix(coll, 'Ints', [[1, 2], [3, 4]])
double_mat = vsp.AddAttributeDoubleMatrix(coll, 'Doubles', [[0.5, 1.5]])
for attribute_id in (bool_id, int_id, double_id, string_id, vec_id, int_mat, double_mat):
    assert attribute_id, 'attribute creation failed'

# The native value getters return vectors, one entry per stored value.
assert vsp.GetAttributeBoolVal(bool_id) == [True]
assert vsp.GetAttributeIntVal(int_id) == [7]
assert abs(vsp.GetAttributeDoubleVal(double_id)[0] - 12.5) < 1e-12
assert vsp.GetAttributeStringVal(string_id) == ['Body']
anchor = vsp.GetAttributeVec3dVal(vec_id)
# The generic vector getter returns component lists rather than vec3d objects.
assert len(anchor) == 2, anchor
second = anchor[1]
z = second.z() if hasattr(second, 'z') else second[2]
assert abs(z - 6.0) < 1e-12, second

assert vsp.GetAttributeIntMatrixVal(int_mat) == [[1, 2], [3, 4]]
assert vsp.GetAttributeDoubleMatrixVal(double_mat) == [[0.5, 1.5]]

vsp.SetAttributeIntMatrix(int_mat, [[9, 8, 7]])
assert vsp.GetAttributeIntMatrixVal(int_mat) == [[9, 8, 7]]
vsp.SetAttributeDoubleMatrix(double_mat, [[2.5], [3.5]])
assert vsp.GetAttributeDoubleMatrixVal(double_mat) == [[2.5], [3.5]]
`],
    ['lookup by name, parm attribute and deletion', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
parm = vsp.GetGeomParmIDs(pod)[0]
coll = vsp.GetChildCollection(pod)

first = vsp.AddAttributeDouble(coll, 'Shared', 1.0)
second = vsp.AddAttributeDouble(coll, 'Shared', 2.0)

# Name lookups find both entries.
by_name = vsp.GetAttributeIDVec(coll, 'Shared')
assert set(by_name) == {first, second}, by_name
# The name search is a substring match on the attribute names.
found = vsp.FindAttributesInCollectionByName(coll, 'Shar')
assert set(found) == {first, second}, found
assert vsp.GetAttributeID(coll, 'Shared', 0) in (first, second)
assert vsp.GetAttributeID(coll, 'NoSuchAttribute') == ''

# A parm attribute keeps the parameter ID.
parm_attr = vsp.AddAttributeParm(coll, 'Linked', parm)
assert parm_attr
# A parm attribute records an index into the collection's parm list.
assert isinstance(vsp.GetAttributeParmVal(parm_attr), list)

vsp.DeleteAttribute(first)
remaining = vsp.GetAttributeIDVec(coll, 'Shared')
assert first not in remaining and second in remaining, remaining
`],
    ['invalid attribute arguments are refused', `
import openvsp as vsp
vsp.ClearVSPModel()
pod = vsp.AddGeom('POD')
vsp.Update()
# A double value on an unknown attribute reads back empty, while the matrix
# getter reports the native error.
assert vsp.GetAttributeDoubleVal('no-such-attribute') == []
try:
    vsp.GetAttributeIntMatrixVal('no-such-attribute')
except vsp.OpenVSPError:
    pass
else:
    raise AssertionError('invalid attribute accepted')
coll = vsp.GetChildCollection(pod)
for call in (lambda: vsp.AddAttributeIntMatrix(coll, 'Bad', []),
             lambda: vsp.AddAttributeDoubleMatrix(coll, 'Bad', [[1.0], []])):
    try:
        call()
    except ValueError:
        pass
    else:
        raise AssertionError('invalid matrix accepted')
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
