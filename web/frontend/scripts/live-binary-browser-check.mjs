// Requires a DEV frontend and an isolated WEBVSP_LIVE_BINARY_TEST engine build.
// WEBVSP_URL=http://127.0.0.1:5173/ CHROMIUM_PATH=/path/to/chromium node scripts/live-binary-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:5173/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = [], external = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  const url = new URL(base)
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__runPython === 'function')
  const id = await page.evaluate(async () => {
    if (!window.__webvspEngine?.testCall) throw new Error('A development frontend is required')
    return window.__webvspEngine.testCall('liveBinaryTestFixture')
  })
  assert.ok(typeof id === 'string' && id.length, 'fixture operation must return a result ID')
  const stringId = await page.evaluate(() => window.__webvspEngine.testCall('liveBinaryStringTestFixture'))
  assert.ok(typeof stringId === 'string' && stringId.length)
  const code = `
import json, math
import openvsp as vsp
live = vsp
root = ${JSON.stringify(id)}
string_root = ${JSON.stringify(stringId)}
requests = []
original_request = live.request
def recording(op, raw):
    if op in ('live_result_binary_field', 'live_result_object'):
        requests.append((op, json.loads(raw)))
    return original_request(op, raw)
live.request = recording
try:
    for n in (0, 4095, 4096, 4097, 8193):
        start = len(requests)
        values = vsp.GetDoubleResults(root, 'n%d' % n)
        assert len(values) == n
        for i, value in enumerate(values):
            if n >= 4096 and i in (4093, 4096): assert math.isnan(value)
            elif n >= 4096 and i == 4094: assert value == math.inf
            elif n >= 4096 and i == 4095: assert value == -math.inf
            else: assert value == float(i), (n, i, value)
        chunks = [args for op, args in requests[start:] if op == 'live_result_binary_field']
        assert [(c['row'], c['offset']) for c in chunks] == [(0, i) for i in (range(0, n, 4096) if n else (0,))], (n, chunks)
    m = vsp.GetDoubleMatResults(root, 'matrix')
    assert len(m) == 4 and m[0] == [] and m[2] == []
    assert math.isnan(m[1][0]) and m[1][1:] == [math.inf, -math.inf]
    assert m[3] == [7.0] * 4097
    assert vsp.GetDoubleMatResults(root, 'empty_matrix') == []
    assert vsp.GetIntResults(root, 'ints') == [-2147483648, 0, 2147483647]
    p = vsp.GetVec3dResults(root, 'points')[0]
    assert math.isnan(p.x()) and p.y() == math.inf and p.z() == -math.inf
    start = len(requests)
    strings = vsp.GetStringResults(string_root, 'strings')
    assert strings == ['', 'a' * 4095 + '€' + 'b' * (8 * 1024 * 1024), '😀', 'tail']
    assert vsp.GetStringResults(string_root, 'empty_strings') == []
    chunks = [args for op, args in requests[start:] if op == 'live_result_binary_field']
    assert any(c['row'] == 1 and c['offset'] == 4096 for c in chunks)
    assert vsp.GetIntResults(string_root, 'strings') == []
    # The aggregate VRO1 path must be exercised, not its per-field fallback.
    start = len(requests)
    obj = vsp.parse_results_object(root)
    batch = requests[start:]
    assert [op for op, _ in batch] == ['live_result_object'], batch
    assert len(obj.n8193) == 8193 and math.isnan(obj.n8193[4096])
    assert math.isnan(obj.matrix[1][0]) and obj.matrix[1][1:] == [math.inf, -math.inf]
    assert obj.empty_matrix == []
    assert math.isnan(obj.points[0][0]) and obj.points[0][1:] == [math.inf, -math.inf]
    assert vsp.GetResultSnapshotCapabilities()['max_ids'] == 32
    batch = vsp.GetResultSnapshots([root, 'missing', string_root, root])
    assert [x['status'] for x in batch] == ['ok', 'unknown', 'over_limit_or_unsupported', 'ok']
    assert math.isnan(batch[0]['data']['values'][('n8193', 0, 2)][4096])
    assert batch[3]['id'] == root
    summary = json.dumps({'ok': True, 'requests': len(requests)})
finally:
    live.request = original_request
summary
`
  const result = await page.evaluate(code => window.__runPython(code), code)
  const parsed = typeof result === 'string' ? JSON.parse(result) : result
  assert.equal(parsed?.ok, true, JSON.stringify(result))
  assert.deepEqual(errors, [], 'browser errors')
  assert.deepEqual(external, [], 'unexpected external requests')
  console.log('PASS live WASM → browser → Pyodide VRB2/VRO1', parsed)
} finally {
  await browser.close()
}
