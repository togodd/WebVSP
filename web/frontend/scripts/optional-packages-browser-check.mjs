// Real Chromium/Pyodide check for the on-demand scientific stack.
// WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... \
//   WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/optional-packages-browser-check.mjs
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
    ['matplotlib renders a PNG without a display', `
import io
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

figure, axes = plt.subplots(figsize=(2, 2))
axes.plot([0.0, 1.0, 2.0], [0.0, 1.0, 4.0])
buffer = io.BytesIO()
figure.savefig(buffer, format='png')
png = buffer.getvalue()
plt.close(figure)
assert png[:8] == b'\\x89PNG\\r\\n\\x1a\\n', png[:8]
print('png bytes:', len(png))
`],
    ['pandas frames and numpy interop', `
import numpy as np
import pandas as pd
frame = pd.DataFrame({'cd': [0.0038, 0.0104], 'alpha': [0.0, 4.0]})
assert frame['cd'].max() == 0.0104
assert list(frame.columns) == ['cd', 'alpha']
series = pd.Series(np.linspace(0.0, 1.0, 5))
assert len(series) == 5 and abs(float(series.iloc[-1]) - 1.0) < 1e-12
print(frame.to_dict('list'))
`],
    ['scipy statistics still available', `
import numpy as np
import scipy.stats as stats
value = stats.norm.cdf(0.0)
assert abs(value - 0.5) < 1e-12, value
from scipy.optimize import minimize_scalar
result = minimize_scalar(lambda x: (x - 2.0) ** 2)
assert abs(result.x - 2.0) < 1e-6, result.x
print('scipy ok')
`],
    ['utilities atmosphere now imports on demand', `
import openvsp as vsp
from utilities import atmosphere
alt = atmosphere.Atmosphere(0.0)
assert alt is not None
print('atmosphere ok')
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
      console.log(`PASS ${name}`, (result.stdout ?? '').trim().split('\n').slice(-1)[0])
    } catch (error) {
      failures.push(`${name}: ${error.stack || error}`)
      console.error(`FAIL ${name}:`, String(error.message).slice(0, 400))
    }
  }
  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors)}`)
  if (failures.length) throw Error(failures.join('\n\n'))
} finally { await browser.close() }
