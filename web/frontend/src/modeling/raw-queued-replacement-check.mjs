// Raw queue regression only: use a disposable WEBVSP_SCRIPT_GUARD_TEST build and
// a disposable Chromium. This does not exercise the modeling facade or a user model.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome \
// WEBVSP_TEST_WASM_DIR=/absolute/path/to/wasm node src/modeling/raw-queued-replacement-check.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
const wasmDir = process.env.WEBVSP_TEST_WASM_DIR
if (!executablePath || !wasmDir || !isAbsolute(wasmDir)) throw new Error('Set WEBVSP_TEST_CHROMIUM and an absolute WEBVSP_TEST_WASM_DIR')
// Use trusted local artifacts only; lstat rejects symlink files, not malicious
// parent directories or filesystem races. It cannot establish artifact provenance.
// Timer callbacks cannot interrupt a blocked filesystem/system call. Forced exit
// also cannot guarantee Chromium cleanup; use external process supervision.
const hardStop = setTimeout(() => { console.error('FAIL: test or cleanup hung'); process.exit(1) }, 210000)
const loadAsset = async name => {
  const path = resolve(wasmDir, name)
  if (!(await lstat(path)).isFile()) throw new Error(`Expected regular local artifact: ${path}`)
  return readFile(path)
}
let assets
try {
  assets = {
    '/wasm/vsp.js': ['text/javascript', await loadAsset('vsp.js')],
    '/wasm/vsp.wasm': ['application/wasm', await loadAsset('vsp.wasm')],
  }
} catch (error) { clearTimeout(hardStop); throw error }
const server = createServer((req, res) => {
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' }
  if (req.url === '/') { res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Disposable raw queue test</title>'); return }
  const asset = assets[req.url]
  if (!asset) { res.writeHead(404, headers); res.end(); return }
  res.writeHead(200, { ...headers, 'Content-Type': asset[0] }); res.end(asset[1])
})
let browser
let timer
try {
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { timeout: 30000 })
  const work = page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required')
    const { default: createVspModule } = await import('/wasm/vsp.js')
    const vsp = await createVspModule()
    for (const name of ['call', 'callGuarded', 'take', 'testBarrierArm', 'testBarrierState', 'testBarrierRelease'])
      if (typeof vsp[name] !== 'function') throw new Error(`Missing ${name}; test-only WASM required`)
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const wait = async (condition, label, timeout = 30000) => {
      const end = performance.now() + timeout
      while (performance.now() < end) { const value = condition(); if (value) return value; await sleep(10) }
      throw new Error(`Timeout: ${label}; barrier=${vsp.testBarrierState()}`)
    }
    const take = () => JSON.parse(vsp.take()).out
    let id = 0
    let messages = []
    const drain = () => messages.push(...take())
    const response = (n) => messages.find(m => m.t === 'result' && m.id === n)
    const request = async (op, a = '') => {
      const n = ++id
      vsp.call(n, op, a, '', 0)
      const r = await wait(() => { drain(); return response(n) }, op)
      if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r)}`)
      return r.value
    }
    try {
      await wait(() => { drain(); return messages.some(m => m.type === 'engine_ready') }, 'engine ready', 120000)
      const cases = []
      for (const type of ['FUSELAGE', 'WING']) for (const replacementFirst of [true, false]) {
        await request('newModel')
        const geom = (await request('addGeom', type)).id
        const model = await request('model')
        if (!geom || !model.modelEpochValid || !model.modelEpoch) throw new Error('Invalid fixture or epoch')
        const op = type === 'WING' ? 'wingXSecShapes' : 'fuselageXSecShapes'
        const baselineId = ++id
        vsp.callGuarded(baselineId, op, geom, '', 0, model.modelEpoch)
        const baseline = await wait(() => { drain(); return response(baselineId) }, 'shape baseline')
        if (!baseline.ok || !baseline.value?.length || !baseline.value[0].xsecs?.length) throw new Error(`Bad baseline: ${JSON.stringify(baseline)}`)
        messages = []
        if (!vsp.testBarrierArm(2)) throw new Error('Cannot arm phase 2')
        const blocker = ++id
        vsp.callGuarded(blocker, 'addGeom', 'BLANK', '', 0, model.modelEpoch)
        try {
          await wait(() => vsp.testBarrierState() === 2, 'phase 2 paused', 10000)
          const replacement = ++id, shape = ++id
          // Both are synchronously enqueued while the engine thread is paused.
          const enqueueReplacement = () => vsp.call(replacement, 'newModel', '', '', 0)
          const enqueueShape = () => vsp.callGuarded(shape, op, geom, '', 0, model.modelEpoch)
          if (replacementFirst) { enqueueReplacement(); enqueueShape() } else { enqueueShape(); enqueueReplacement() }
          if (vsp.testBarrierState() !== 2) throw new Error('Barrier timed out during enqueue')
          drain()
          if ([blocker, replacement, shape].some(response)) throw new Error('A queued result escaped the barrier')
          vsp.testBarrierRelease()
          await wait(() => { drain(); return response(blocker) && response(replacement) && response(shape) }, 'queued results')
          const finalModel = await request('model') // fence after all three jobs
          cases.push({ type, replacementFirst, baseline: baseline.value, oldEpoch: model.modelEpoch, finalModel, blocker, replacement, shape, messages })
        } finally { vsp.testBarrierRelease() }
      }
      return cases
    } finally { vsp.testBarrierRelease() }
  })
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test exceeded 180 seconds')), 180000) })
  const cases = await Promise.race([work, timeout])
  for (const c of cases) {
    const label = `${c.type}/${c.replacementFirst ? 'replacement-first' : 'shape-first'}`
    const results = c.messages.filter(m => m.t === 'result')
    const one = n => { const found = results.filter(m => m.id === n); assert.equal(found.length, 1, `${label}: result ${n} unique`); return found[0] }
    assert.equal(one(c.blocker).ok, true, `${label}: barrier write`)
    assert.equal(one(c.replacement).ok, true, `${label}: replacement`)
    const shape = one(c.shape)
    if (c.replacementFirst) {
      assert.equal(shape.ok, false, label); assert.equal(shape.code, 'STALE_MODEL', label)
      assert.equal(shape.outcome, 'not_written', label); assert.equal(shape.actual, null, label)
    } else { assert.equal(shape.ok, true, label); assert.deepEqual(shape.value, c.baseline, label) }
    const ids = results.map(r => r.id)
    assert.ok(ids.indexOf(c.blocker) < ids.indexOf(c.replacementFirst ? c.replacement : c.shape), label)
    assert.ok(ids.indexOf(c.replacementFirst ? c.replacement : c.shape) < ids.indexOf(c.replacementFirst ? c.shape : c.replacement), label)
    assert.equal(c.finalModel.modelEpochValid, true, label)
    assert.notEqual(c.finalModel.modelEpoch, c.oldEpoch, label)
  }
  assert.deepEqual(errors, [])
  console.log('PASS: raw queued replacement/shape order for FUSELAGE and WING (4 cases)')
} finally {
  clearTimeout(timer)
  if (browser) await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
  clearTimeout(hardStop)
}
