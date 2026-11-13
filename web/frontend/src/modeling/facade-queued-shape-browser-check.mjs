// Test-only: trusted WEBVSP_SCRIPT_GUARD_TEST artifacts and disposable snapshot.
// Requires WEBVSP_TEST_ROOT (snapshot frontend), WEBVSP_TEST_WASM_DIR and
// WEBVSP_TEST_CHROMIUM, all absolute paths. Never deploy the test WASM.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createServer as createVite } from 'vite'
import { chromium } from 'playwright-core'

const root = process.env.WEBVSP_TEST_ROOT, wasmDir = process.env.WEBVSP_TEST_WASM_DIR, executablePath = process.env.WEBVSP_TEST_CHROMIUM
for (const p of [root, wasmDir, executablePath]) if (!p || !isAbsolute(p)) throw new Error('Set absolute WEBVSP_TEST_ROOT, WEBVSP_TEST_WASM_DIR, WEBVSP_TEST_CHROMIUM')
const assets = {}
for (const name of ['vsp.js', 'vsp.wasm']) {
  const path = join(wasmDir, name)
  if (!(await lstat(path)).isFile()) throw new Error(`Not a regular artifact: ${path}`)
  assets[name] = await readFile(path)
}
const temp = await mkdtemp(join(tmpdir(), 'webvsp-facade-queue-'))
let vite, server, browser, context, primaryError
const cleanupErrors = []
// Promise.race below does not cancel page.evaluate. The hard exit bounds a hung
// cleanup but cannot guarantee browser/process cleanup; external supervision is needed.
const hardStop = setTimeout(() => { console.error('FAIL: test/cleanup deadline exceeded'); process.exit(1) }, 210000)
const wrapper = `import create from '/wasm/native/vsp.js';
export default async function(...args) {
 const m = await create(...args), call = m.call.bind(m), guarded = m.callGuarded.bind(m), take = m.take.bind(m);
 const state = window.__queueProbe = { m, armed: null, records: [], logs: [], errors: [] };
 m.take = function() { const raw = take(); try { const out = JSON.parse(raw).out; for (const r of out) if (r.t === 'result' && (r.id < 0 || r.id === state.shapeId)) state.records.push(r) } catch (e) { state.errors.push(String(e)) } return raw };
 m.callGuarded = function(id, op, a, b, value, epoch) {
  const c = state.armed;
  if (!c || op !== c.op || a !== c.geom) return guarded(id, op, a, b, value, epoch);
  state.armed = null; state.shapeId = id; state.logs.push(['shape-wrapper', id, op, epoch]);
  if (!m.testBarrierArm(2)) throw Error('arm failed');
  guarded(-1, 'addGeom', 'BLANK', '', 0, epoch); state.logs.push(['blocker-enqueued', -1]);
  const shape = () => { guarded(id, op, a, b, value, epoch); state.logs.push(['shape-enqueued', id]) };
  const replacement = () => { call(-2, 'newModel', '', '', 0); state.logs.push(['new-enqueued', -2]) };
  if (c.first) { replacement(); shape() } else { shape(); replacement() }
  state.logs.push(['enqueue-ack']);
 };
 return m;
}`
try {
  vite = await createVite({ configFile: false, root, cacheDir: join(temp, 'vite-cache'), logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  server = createServer((req, res) => {
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Disposable facade queue test</title>') }
    if (req.url === '/wasm/vsp.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(wrapper) }
    const name = req.url?.match(/^\/wasm\/native\/(vsp\.js|vsp\.wasm)$/)?.[1]
    if (name) { res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); return res.end(assets[name]) }
    vite.middlewares(req, res)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ executablePath, headless: true, timeout: 30000, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
  context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
  await context.route('**/*', route => { const r = route.request(); return r.method() === 'GET' && new URL(r.url()).origin === origin ? route.continue() : route.abort() })
  await context.addInitScript(() => { for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) window[name] = () => { throw Error('Forbidden picker') }; document.addEventListener('click', e => { if (e.target instanceof Element && e.target.closest('a[download],input[type=file]')) { e.preventDefault(); throw Error('Forbidden file action') } }, true) })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message)); page.on('download', () => errors.push('download')); page.on('filechooser', () => errors.push('file chooser')); page.on('crash', () => errors.push('crash'))
  await page.goto(origin, { timeout: 30000 })
  const work = page.evaluate(async () => {
    if (!crossOriginIsolated) throw Error('Not cross-origin isolated')
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const { wasmConnect } = await import('/src/api/wasmEngine.ts')
    wasmConnect(() => {}, () => {})
    const api = createBrowserModelingService(), engine = window.__webvspEngine
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const wait = async (fn, label, timeout = 30000) => { const until = performance.now() + timeout; while (performance.now() < until) { const v = fn(); if (v) return v; await sleep(10) } throw Error(`Timeout ${label}`) }
    const initial = await api.model.getInfo()
    if (initial.geometries.length) throw Error('Nonempty model')
    const cases = []
    try {
      for (const type of ['WING', 'FUSELAGE']) for (const first of [true, false]) {
        await engine.testCall('newModel')
        const geom = (await engine.testCall('addGeom', type)).id
        const identity = (await api.model.getInfo()).identity
        const op = type === 'WING' ? 'wingXSecShapes' : 'fuselageXSecShapes'
        const read = () => type === 'WING' ? api.wing.get(geom, identity) : api.fuselage.get(geom, identity)
        const baseline = await read(), probe = window.__queueProbe
        if (!baseline.surfaces.length || !(type === 'WING' ? baseline.surfaces[0].stations : baseline.surfaces[0].sections).length) throw Error('Empty baseline')
        for (const name of ['testBarrierArm','testBarrierState','testBarrierRelease']) if (typeof probe.m[name] !== 'function') throw Error(`Missing ${name}`)
        probe.records = []; probe.logs = []; probe.errors = []; probe.shapeId = null; probe.armed = { op, geom, first }
        const pending = read().then(value => ({ value }), e => ({ error: { code: e.code, message: e.message } }))
        try {
          await wait(() => probe.logs.some(l => l[0] === 'enqueue-ack'), 'enqueue ack')
          await wait(() => probe.m.testBarrierState() === 2, 'phase 2', 10000)
          if (probe.records.length) throw Error('result escaped paused barrier')
          probe.logs.push(['release']); probe.m.testBarrierRelease()
          const facade = await pending
          await wait(() => [-1,-2,probe.shapeId].every(id => probe.records.some(r => r.id === id)), 'three results')
          const final = await engine.testCall('model')
          cases.push({ type, first, identity, baseline, facade, final, records: probe.records.slice(), logs: probe.logs.slice(), shapeId: probe.shapeId, errors: probe.errors.slice() })
        } finally { probe.m.testBarrierRelease() }
      }
      return cases
    } finally { api.close(); window.__queueProbe?.m.testBarrierRelease() }
  })
  let timer
  const cases = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Test timed out')), 180000) })]).finally(() => clearTimeout(timer))
  for (const c of cases) {
    const label = `${c.type}/${c.first ? 'new-first' : 'shape-first'}`
    const one = id => { const all = c.records.filter(r => r.id === id); assert.equal(all.length, 1, `${label} unique ${id}`); return all[0] }
    assert.ok(c.shapeId > 0, label)
    assert.equal(one(-1).ok, true, label); assert.equal(one(-2).ok, true, label)
    const shape = one(c.shapeId)
    if (c.first) { assert.equal(shape.ok, false, label); assert.equal(shape.code, 'STALE_MODEL', label); assert.equal(shape.outcome, 'not_written', label); assert.equal(shape.actual, null, label); assert.equal(c.facade.error?.code, 'STALE_MODEL', label) }
    else {
      assert.equal(shape.ok, true, label)
      const raw = shape.value.map(s => ({ id: s.id, sections: s.xsecs.map(x => ({ id: x.id, shape: x.shape })) }))
      const normalized = c.baseline.surfaces.map(s => ({ id: s.id, sections: (s.stations ?? s.sections).map(x => ({ id: x.id, shape: x.shape })) }))
      assert.deepEqual(raw, normalized, label); assert.deepEqual(c.facade.value.surfaces, c.baseline.surfaces, label)
    }
    assert.deepEqual(c.records.map(r => r.id), [-1, ...(c.first ? [-2, c.shapeId] : [c.shapeId, -2])], label)
    const validEpoch = epoch => typeof epoch === 'string' && /^(0|[1-9][0-9]*)$/.test(epoch) && (epoch.length < 20 || (epoch.length === 20 && epoch <= '18446744073709551615'))
    assert.ok(validEpoch(c.identity.modelEpoch) && validEpoch(c.final.modelEpoch), `${label}: canonical uint64 epochs`)
    assert.deepEqual(c.logs[0], ['shape-wrapper', c.shapeId, c.type === 'WING' ? 'wingXSecShapes' : 'fuselageXSecShapes', c.identity.modelEpoch], `${label}: exact old token passed to shape`)
    assert.equal(c.final.modelEpochValid, true, label); assert.notEqual(c.final.modelEpoch, c.identity.modelEpoch, label)
    assert.deepEqual(c.errors, [], label)
    console.log(`PASS ${label}: ${JSON.stringify({ logs: c.logs, shape: c.facade.error ?? 'baseline match', epoch: [c.identity.modelEpoch, c.final.modelEpoch] })}`)
  }
  assert.deepEqual(errors, [])
} catch (error) {
  primaryError = error
} finally {
  const cleanup = async (name, fn) => {
    try { await fn() } catch (error) { cleanupErrors.push({ name, error }); console.error(`FAIL: cleanup ${name}:`, error) }
  }
  if (context) await cleanup('context', () => context.close())
  if (browser) await cleanup('browser', () => browser.close())
  if (server?.listening) await cleanup('server', () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  if (vite) await cleanup('vite', () => vite.close())
  await cleanup('temporary directory', () => rm(temp, { recursive: true, force: true }))
  clearTimeout(hardStop)
}
if (primaryError) throw primaryError
if (cleanupErrors.length) throw new AggregateError(cleanupErrors.map(e => e.error), `Cleanup failed: ${cleanupErrors.map(e => e.name).join(', ')}`)
