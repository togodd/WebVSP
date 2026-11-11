// Run from web/frontend after `npm run build -- --outDir /absolute/path/to/dist`:
// WEBVSP_TEST_DIST=/absolute/path/to/dist WEBVSP_TEST_CHROMIUM=/path/to/chrome \
//   node src/modeling/production-read-api-check.mjs
// Uses the existing 5179 origin and 5180 WASM server by default; override with
// WEBVSP_TEST_ORIGIN and WEBVSP_TEST_WASM_ORIGIN. It does not start a server.
// Production files are fulfilled from dist, WASM files from the existing server.
// Only a fresh headless Chromium context is used; no user profile or files are opened.
import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'

const dist = process.env.WEBVSP_TEST_DIST
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!dist || !isAbsolute(dist) || !executablePath) throw new Error('Set WEBVSP_TEST_DIST to an absolute build directory and WEBVSP_TEST_CHROMIUM to a Chromium executable')
const root = resolve(dist)
const origin = new URL(process.env.WEBVSP_TEST_ORIGIN ?? 'http://127.0.0.1:5179').origin
const wasmOrigin = new URL(process.env.WEBVSP_TEST_WASM_ORIGIN ?? 'http://127.0.0.1:5180').origin
for (const value of [origin, wasmOrigin]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw new Error('Test origins must be loopback addresses')
}
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' })
const paths = [], failures = [], errors = []
try {
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`))
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    paths.push(url.pathname)
    if (url.origin !== origin) return route.abort()
    if (url.pathname.startsWith('/wasm/')) {
      const response = await route.fetch({ url: `${wasmOrigin}${url.pathname}${url.search}`, timeout: 120000 })
      return route.fulfill({ response, headers: { ...response.headers(), 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    if (!path.startsWith(root + sep)) return route.abort()
    try {
      const body = await readFile(path)
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream'
      return route.fulfill({ status: 200, body, headers: { 'content-type': type, 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' } })
    } catch { return route.abort() }
  })
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  try { await page.waitForSelector('[data-ready="1"]', { timeout: 120000 }) }
  catch (error) {
    console.error(JSON.stringify({ paths, failures, errors, text: (await page.locator('body').innerText()).slice(0, 1500) }, null, 2))
    throw error
  }
  const result = await page.evaluate(async () => {
    const api = window.__webvspModelingReadV1
    if (!api) throw new Error('Missing production entry')
    const info = await api.model.getInfo(), again = await api.model.getInfo(), list = await api.geometry.list(info.identity)
    return {
      isolated: crossOriginIsolated, sameEntry: api === window.__webvspModelingReadV1, info, again, list,
      top: Object.keys(api).sort(),
      keys: Object.fromEntries(['model', 'geometry', 'parameter', 'wing', 'fuselage'].map(k => [k, Object.keys(api[k]).sort()])),
    }
  })
  assert.equal(result.isolated, true)
  assert.equal(result.sameEntry, true)
  assert.deepEqual(result.info, result.again)
  assert.equal(result.info.geometries.length, 0, 'Expected an empty disposable model')
  assert.deepEqual(result.list.geometries ?? result.list, result.info.geometries)
  assert.deepEqual(result.top, ['capabilities', 'declaredCapabilities', 'fuselage', 'geometry', 'model', 'parameter', 'protocol', 'wing'])
  assert.deepEqual(result.keys, {
    model: ['getInfo', 'getSelection', 'getVisibleSurfaceBounds'], geometry: ['get', 'list'],
    parameter: ['getCrossSectionParameter', 'getFuselageLength', 'getGeometryParameter', 'listCrossSectionParameterIds', 'listGeometryParameterIds', 'listSurfaces'],
    wing: ['get'], fuselage: ['get'],
  })
  assert.ok(paths.some(p => p === '/wasm/vsp.js'))
  assert.equal(paths.filter(p => p === '/wasm/vsp.wasm').length, 1)
  assert.ok(paths.some(p => /^\/assets\/index-.*\.js$/.test(p)))
  assert.ok(!paths.some(p => p.startsWith('/src/') || p.startsWith('/@vite/')))
  assert.deepEqual(errors, [])
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ pass: true, paths, session: result.info.identity, geometryCount: result.info.geometries.length, keys: result.keys }, null, 2))
} finally {
  await context.close()
  await browser.close()
}
