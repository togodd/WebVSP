// Real Chromium + production WASM facade write E2E. Run only after the write
// facade is wired; current disabled implementations intentionally fail this test.
// From web/frontend, after npm ci and a production engine build:
//   WEBVSP_TEST_CHROMIUM=/absolute/path/to/chromium \
//   WEBVSP_TEST_WASM_DIR=/absolute/path/to/production/wasm \
//     node src/modeling/facade-write-browser-check.mjs
// The WASM directory must contain the matching production vsp.js and vsp.wasm,
// built from the same revision with guarded write operations. Do not use a test
// or instrumented engine. Source modules are served by a private Vite middleware;
// no pre-existing server, browser profile, model, or user file is touched.
// Chromium must support pthread WASM/SharedArrayBuffer. --no-sandbox is used for
// container compatibility; run only trusted local source and artifacts in isolation.
// A hard deadline bounds hangs, but an external supervisor may still be needed to
// reap Chromium if the process is forcibly terminated.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const wasmDir = process.env.WEBVSP_TEST_WASM_DIR
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
for (const [name, path] of [['WEBVSP_TEST_WASM_DIR', wasmDir], ['WEBVSP_TEST_CHROMIUM', executablePath]]) {
  if (!path || !isAbsolute(path)) throw new Error(`Set ${name} to an absolute path`)
}
const assets = new Map()
for (const name of ['vsp.js', 'vsp.wasm']) {
  const path = join(wasmDir, name)
  if (!(await lstat(path)).isFile()) throw new Error(`Not a regular production artifact: ${path}`)
  assets.set(`/wasm/${name}`, await readFile(path))
}
const temp = await mkdtemp(join(tmpdir(), 'webvsp-facade-write-'))
let vite, server, browser, context, primaryError
const cleanupErrors = []
const deadline = setTimeout(() => { console.error('FAIL: facade write test/cleanup deadline exceeded'); process.exit(1) }, 240000)
try {
  vite = await createVite({ configFile: false, root, cacheDir: join(temp, 'vite-cache'), logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  server = createServer((req, res) => {
    for (const [key, value] of Object.entries({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' })) res.setHeader(key, value)
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Disposable facade write E2E</title>') }
    if (assets.has(path)) { res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); return res.end(assets.get(path)) }
    vite.middlewares(req, res)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  // Check bytes from the actual HTTP endpoint, not merely the source files.
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  for (const [path, expected] of assets) {
    const response = await fetch(`${origin}${path}`, { redirect: 'error' })
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', path)
    assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp', path)
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(expected), `HTTP SHA-256 ${path}`)
    console.log(`HTTP SHA-256 ${path}: ${digest(expected)}`)
  }
  const documentResponse = await fetch(origin, { redirect: 'error' })
  assert.equal(documentResponse.headers.get('cross-origin-opener-policy'), 'same-origin')
  assert.equal(documentResponse.headers.get('cross-origin-embedder-policy'), 'require-corp')
  browser = await chromium.launch({ executablePath, headless: true, timeout: 30000, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
  context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
  const assetResponses = new Map(), routeErrors = []
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== 'GET' || url.origin !== origin) return route.abort()
    if (!assets.has(url.pathname)) return route.continue()
    try {
      const response = await route.fetch({ maxRedirects: 0 })
      assert.equal(response.status(), 200, url.pathname)
      const headers = response.headers()
      assert.equal(headers['cross-origin-opener-policy'], 'same-origin', url.pathname)
      assert.equal(headers['cross-origin-embedder-policy'], 'require-corp', url.pathname)
      const body = await response.body()
      assert.equal(digest(body), digest(assets.get(url.pathname)), `Chromium HTTP SHA-256 ${url.pathname}`)
      assetResponses.set(url.pathname, (assetResponses.get(url.pathname) ?? 0) + 1)
      await route.fulfill({ response, body })
    } catch (error) {
      routeErrors.push(error)
      await route.abort().catch(() => {})
    }
  })
  await context.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) window[name] = () => { throw Error('File picker forbidden in disposable test') }
    document.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('a[download],input[type=file]')) { event.preventDefault(); throw Error('File action forbidden in disposable test') } }, true)
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('download', () => errors.push('unexpected download'))
  page.on('filechooser', () => errors.push('unexpected file chooser'))
  page.on('crash', () => errors.push('page crashed'))
  await page.goto(origin, { timeout: 30000 })
  const work = page.evaluate(async () => {
    if (!crossOriginIsolated) throw Error('Cross-origin isolation is required')
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const { wasmConnect } = await import('/src/api/wasmEngine.ts')
    const { api: raw } = await import('/src/api/client.ts')
    const connection = wasmConnect(() => {}, () => {})
    const facade = createBrowserModelingService()
    const capture = async fn => { try { return { value: await fn() } } catch (e) { return { error: { code: e?.code, details: e?.details, message: e?.message } } } }
    try {
      const initial = await facade.model.getInfo()
      if (initial.geometries.length) throw Error('Refusing to write a nonempty model')
      const token = initial.identity
      const capabilities = facade.capabilities().features.filter(x => ['geometry.create', 'geometry.move', 'parameter.write'].includes(x.name))
      const created = await facade.write.create({ type: 'FUSELAGE', parentId: null }, token)
      const id = created.geometryId
      const afterCreate = await facade.model.getInfo(token)
      const originBefore = await raw.geomOrigin(id)
      const moved = await facade.write.move({ geometryId: id, frame: 'world', units: 'model-native', delta: [1, 2, 3] }, token)
      const originAfter = await raw.geomOrigin(id)
      const length = await facade.parameter.getFuselageLength(id, token)
      const target = length.value === 20 ? 21 : 20
      if (!length.active || typeof length.value !== 'number' || typeof length.lowerLimit !== 'number' || typeof length.upperLimit !== 'number' || target < length.lowerLimit || target > length.upperLimit) throw Error('Unexpected fuselage length baseline')
      const input = { owner: 'geometry', ownerId: id, parameterId: length.id, value: target }
      const set = await facade.parameter.set(input, token)
      const afterSet = await facade.parameter.getGeometryParameter(id, length.id, token)
      const invalid = await capture(() => facade.parameter.set({ ...input, value: length.upperLimit + 1 }, token))
      const afterInvalid = await facade.parameter.getGeometryParameter(id, length.id, token)
      const wingCreated = await facade.write.create({ type: 'WING', parentId: null }, token)
      const wingId = wingCreated.geometryId
      const afterWingCreate = await facade.model.getInfo(token)
      const wingIds = await facade.parameter.listGeometryParameterIds(wingId, token)
      const wingParameters = []
      for (const parmId of wingIds) wingParameters.push(await facade.parameter.getGeometryParameter(wingId, parmId, token))
      const wingSpan = wingParameters.find(p => p.name === 'TotalSpan' && p.container === wingId && p.active)
      if (!wingSpan || !Number.isFinite(wingSpan.value) || !Number.isFinite(wingSpan.lowerLimit) || !Number.isFinite(wingSpan.upperLimit)) throw Error('No usable wing TotalSpan parameter discovered')
      const wingTarget = wingSpan.value * 1.1
      if (!Number.isFinite(wingTarget) || wingTarget === wingSpan.value || wingTarget < wingSpan.lowerLimit || wingTarget > wingSpan.upperLimit) throw Error('Wing TotalSpan target is outside limits')
      const wingSet = await facade.parameter.set({ owner: 'geometry', ownerId: wingId, parameterId: wingSpan.id, value: wingTarget }, token)
      const wingAfterSet = await facade.parameter.getGeometryParameter(wingId, wingSpan.id, token)
      const wingOriginBefore = await raw.geomOrigin(wingId)
      const wingMoved = await facade.write.move({ geometryId: wingId, frame: 'world', units: 'model-native', delta: [-2, 1, 4] }, token)
      const wingOriginAfter = await raw.geomOrigin(wingId)
      // Replacement acts only on this new browser's in-memory engine, never a user session.
      await window.__webvspEngine.request('POST', '/file/new')
      const replaced = await facade.model.getInfo()
      const staleCreate = await capture(() => facade.write.create({ type: 'FUSELAGE', parentId: null }, token))
      const staleMove = await capture(() => facade.write.move({ geometryId: id, frame: 'world', units: 'model-native', delta: [1, 0, 0] }, token))
      const staleSet = await capture(() => facade.parameter.set(input, token))
      const final = await facade.model.getInfo()
      facade.close()
      const closed = await capture(() => facade.write.create({ type: 'FUSELAGE', parentId: null }, replaced.identity))
      const closedMove = await capture(() => facade.write.move({ geometryId: wingId, frame: 'world', units: 'model-native', delta: [1, 0, 0] }, replaced.identity))
      const closedSet = await capture(() => facade.parameter.set(input, replaced.identity))
      return { initial, capabilities, created, afterCreate, originBefore, moved, originAfter, length, target, set, afterSet, invalid, afterInvalid, wingCreated, afterWingCreate, wingIds, wingSpan, wingTarget, wingSet, wingAfterSet, wingOriginBefore, wingMoved, wingOriginAfter, replaced, staleCreate, staleMove, staleSet, final, closed, closedMove, closedSet }
    } finally { facade.close(); connection.close() }
  })
  let timer
  const r = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Facade write test timed out; dispatched writes are not retried')), 200000) })]).finally(() => clearTimeout(timer))
  assert.equal(r.capabilities.length, 3)
  for (const c of r.capabilities) assert.equal(c.status, 'supported', c.name)
  assert.ok(r.created.geometryId)
  assert.equal(r.afterCreate.geometries.length, 1)
  assert.deepEqual({ id: r.afterCreate.geometries[0].id, type: r.afterCreate.geometries[0].type.toUpperCase(), parentId: r.afterCreate.geometries[0].parentId }, { id: r.created.geometryId, type: 'FUSELAGE', parentId: null })
  assert.deepEqual(r.afterCreate.identity, r.initial.identity)
  assert.equal(r.moved.geometryId, r.created.geometryId)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(r.originAfter[i] - r.originBefore[i] - [1, 2, 3][i]) < 1e-7, `origin axis ${i}`)
    assert.ok(Math.abs(r.moved.origin[i] - r.originAfter[i]) < 1e-7, `move readback axis ${i}`)
  }
  assert.notEqual(r.length.value, r.target)
  assert.deepEqual(r.set, { actual: r.target })
  assert.equal(r.afterSet.value, r.target)
  assert.equal(r.invalid.error?.code, 'ENGINE_ERROR')
  assert.deepEqual(r.invalid.error?.details, { outcome: 'not_written', actual: r.target })
  assert.equal(r.afterInvalid.value, r.target)
  assert.ok(r.wingCreated.geometryId)
  assert.notEqual(r.wingCreated.geometryId, r.created.geometryId)
  assert.equal(r.afterWingCreate.geometries.length, 2)
  const wing = r.afterWingCreate.geometries.find(g => g.id === r.wingCreated.geometryId)
  assert.ok(wing)
  assert.equal(wing.type.toUpperCase(), 'WING')
  assert.equal(wing.parentId, null)
  assert.deepEqual(r.afterWingCreate.identity, r.initial.identity)
  assert.ok(r.wingIds.includes(r.wingSpan.id))
  assert.ok(Math.abs(r.wingSet.actual - r.wingTarget) < 1e-7)
  assert.ok(Math.abs(r.wingAfterSet.value - r.wingTarget) < 1e-7)
  assert.equal(r.wingMoved.geometryId, r.wingCreated.geometryId)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(r.wingOriginAfter[i] - r.wingOriginBefore[i] - [-2, 1, 4][i]) < 1e-7, `wing origin axis ${i}`)
    assert.ok(Math.abs(r.wingMoved.origin[i] - r.wingOriginAfter[i]) < 1e-7, `wing move readback axis ${i}`)
  }
  assert.notEqual(r.replaced.identity.modelEpoch, r.initial.identity.modelEpoch)
  assert.deepEqual(r.replaced.geometries, [])
  for (const [name, result] of [['create', r.staleCreate], ['move', r.staleMove], ['set', r.staleSet]]) assert.equal(result.error?.code, 'STALE_MODEL', `stale ${name}`)
  assert.deepEqual(r.final.geometries, r.replaced.geometries)
  assert.deepEqual(r.final.identity, r.replaced.identity)
  for (const [name, result] of [['create', r.closed], ['move', r.closedMove], ['set', r.closedSet]]) assert.equal(result.error?.code, 'SESSION_CLOSED', `closed ${name}`)
  if (routeErrors.length) throw new AggregateError(routeErrors, 'Asset response verification failed')
  for (const path of assets.keys()) assert.ok(assetResponses.get(path), `Chromium did not request ${path}`)
  assert.deepEqual(errors, [])
  console.log('PASS: real Chromium and production WASM facade create/move/parameter.set, readback, invalid, stale and closed')
} catch (error) {
  primaryError = error
} finally {
  const cleanup = async (name, fn) => { try { await fn() } catch (error) { cleanupErrors.push(error); console.error(`FAIL: cleanup ${name}:`, error) } }
  if (context) await cleanup('context', () => context.close())
  if (browser) await cleanup('browser', () => browser.close())
  if (server?.listening) await cleanup('server', () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  if (vite) await cleanup('vite', () => vite.close())
  await cleanup('temporary directory', () => rm(temp, { recursive: true, force: true }))
  clearTimeout(deadline)
}
if (primaryError) throw primaryError
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Facade write test cleanup failed')
