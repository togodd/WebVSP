// Run against a disposable Vite test server serving the newly built WASM:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium WEBVSP_TEST_WASM_DIR=/absolute/path/to/wasm \
//   node src/modeling/guarded-geom-types-wasm-check.mjs
// The directory must contain the matching newly built vsp.js and vsp.wasm pair.
// A Vite development page is required for the JS test hooks; normal production WASM is fine.
// Never attach to an existing browser/profile or open, import, save, or download user files.
// newModel acts only on this fresh context's in-memory WASM filesystem.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const wasmDir = process.env.WEBVSP_TEST_WASM_DIR
if (wasmDir && !isAbsolute(wasmDir)) throw new Error('WEBVSP_TEST_WASM_DIR must be absolute')
const wasmFiles = wasmDir ? new Map(await Promise.all(['vsp.js', 'vsp.wasm'].map(async name => [name, await readFile(join(wasmDir, name))]))) : null
const testPage = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
if (!['http:', 'https:'].includes(testPage.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testPage.hostname)) throw new Error('Test page must be a loopback HTTP(S) URL')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
const injected = new Set()
const timeout = setTimeout(() => { console.error('FAIL: guarded geomTypes test timed out'); void browser.close() }, 180000)
try {
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.abort()
    const match = url.origin === testPage.origin && url.pathname.match(/^\/wasm\/(vsp\.js|vsp\.wasm)$/)
    if (wasmFiles && match) return route.fulfill({ status: 200, body: wasmFiles.get(match[1]), headers: {
      'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin',
    } })
    return route.continue()
  })
  await context.addInitScript(() => {
    const reject = () => { throw new Error('File pickers forbidden in disposable test') }
    Object.assign(window, { showOpenFilePicker: reject, showSaveFilePicker: reject, showDirectoryPicker: reject })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('filechooser', chooser => { errors.push('Unexpected file chooser'); void chooser.setFiles([]) })
  await page.goto(testPage.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation required')
    const engine = window.__webvspEngine
    if (typeof engine?.testCallGuarded !== 'function') throw new Error('Dev test hooks unavailable')
    const { callGuarded, wasmRequest } = await import('/src/api/wasmEngine.ts')
    const before = await engine.testCall('model')
    const bridgeBefore = await wasmRequest('GET', '/model')
    const bridgeLegacy = await wasmRequest('GET', '/geom-types')
    if (!before.modelEpochValid) throw new Error('Invalid initial model epoch')
    const legacy = await engine.testCall('geomTypes')
    const step = async (name, fn) => { try { return await fn() } catch (e) { throw new Error(`${name}: ${e.message}; epoch=${before.modelEpoch}`) } }
    const direct = await step('initial direct', () => engine.testCallGuarded('geomTypes', '', '', 0, before.modelEpoch))
    const bridge = await step('initial bridge', () => callGuarded('geomTypes', '', '', 0, bridgeBefore.modelEpoch))
    await engine.testCall('newModel')
    await wasmRequest('POST', '/file/new')
    const after = await engine.testCall('model')
    const bridgeAfter = await wasmRequest('GET', '/model')
    const capture = async fn => {
      try { return { value: await fn() } }
      catch (e) { return { code: e.code, outcome: e.outcome, actual: e.actual } }
    }
    const staleDirect = await capture(() => engine.testCallGuarded('geomTypes', '', '', 0, before.modelEpoch))
    const staleBridge = await capture(() => callGuarded('geomTypes', '', '', 0, bridgeBefore.modelEpoch))
    const fresh = await step(`fresh bridge after=${JSON.stringify(bridgeAfter.modelEpoch)}`, () => callGuarded('geomTypes', '', '', 0, bridgeAfter.modelEpoch))
    return { before, after, bridgeBefore, bridgeAfter, legacy, bridgeLegacy, direct, bridge, fresh, staleDirect, staleBridge }
  })
  assert.equal(result.after.modelEpochValid, true)
  assert.notEqual(result.before.modelEpoch, result.after.modelEpoch)
  assert.ok(Array.isArray(result.legacy) && result.legacy.length > 0 && result.legacy.every(name => typeof name === 'string'))
  assert.deepEqual(result.direct, result.legacy)
  assert.equal(result.bridgeAfter.modelEpochValid, true)
  assert.notEqual(result.bridgeBefore.modelEpoch, result.bridgeAfter.modelEpoch)
  assert.deepEqual(result.bridge, result.bridgeLegacy)
  assert.deepEqual(result.fresh, result.bridgeLegacy)
  for (const stale of [result.staleDirect, result.staleBridge]) assert.deepEqual(stale, { code: 'STALE_MODEL', outcome: 'not_written', actual: null })
  assert.deepEqual(errors, [])
  console.log('PASS: guarded and legacy geomTypes agree; old epoch rejected by engine and bridge')
} finally {
  clearTimeout(timeout)
  await context.close()
  await browser.close()
}
