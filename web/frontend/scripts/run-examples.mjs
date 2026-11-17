// Run the ported OpenVSP examples in the live engine, one fresh page each.
//
//   WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... \
//   WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/run-examples.mjs
//
// Prints a table and writes the raw outcomes to /tmp/examples-report.json.
import assert from 'node:assert/strict'
import { readFile, stat, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, basename } from 'node:path'
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

const exampleDir = resolve('scripts/examples')
const names = (await readdir(exampleDir)).filter(name => name.endsWith('.py')).sort()
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const results = []
try {
  for (const name of names) {
    const code = await readFile(resolve(exampleDir, name), 'utf8')
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.route('**/*', async route => {
      const request = new URL(route.request().url())
      if (request.origin !== url.origin) return route.abort()
      const match = request.pathname.match(/\/wasm\/(vsp\.js|vsp\.wasm)$/)
      if (match) {
        return route.fulfill({ status: 200, body: files[match[1]].body, headers: { 'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
      }
      return route.continue()
    })
    url.searchParams.set('dualWasmProbe', '1')
    await page.goto(url.href)
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
    const started = Date.now()
    const outcome = await Promise.race([
      page.evaluate(async source => {
        const { startConsoleSession } = await import('/src/dualWasmProbe/syncProbe.ts')
        const session = await startConsoleSession()
        try { return await session.run(source, false) } finally { session.close() }
      }, code).catch(error => ({ ok: false, error: String(error) })),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'timed out after 120s' }), 120000)),
    ])
    results.push({
      name,
      ok: !!outcome.ok,
      error: outcome.ok ? null : String(outcome.error ?? '').split('\n').slice(-3).join(' ').slice(0, 300),
      stdout: (outcome.stdout ?? '').slice(0, 2000),
      ms: Date.now() - started,
      pageErrors,
    })
    console.log(`${outcome.ok ? 'PASS' : 'FAIL'} ${basename(name, '.py')} (${Date.now() - started} ms)`
      + (outcome.ok ? '' : ' -> ' + String(outcome.error ?? '').split('\n').filter(Boolean).pop()?.slice(0, 140)))
    await page.close()
  }
} finally { await browser.close() }

await writeFile('/tmp/examples-report.json', JSON.stringify(results, null, 2))
const passed = results.filter(r => r.ok).length
console.log(`\n${passed}/${results.length} examples ran without raising`)
assert.ok(results.length > 0)
