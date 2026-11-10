// Disposable WEBVSP_SCRIPT_GUARD_TEST WASM only. Never use a user profile or model.
// Serve the disposable build with isolation headers, then run:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/raw-take-concurrency-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const base = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
// Hard stop even if a synchronous WASM call or browser.close wedges.
const deadline = setTimeout(() => { console.error('FAIL: raw take check timed out'); process.exit(1) }, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  // New route, blank document: no app, service worker, or automatic take() drain.
  await page.route('**/__raw_take_test__', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>Disposable raw WASM test</title>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' },
  }))
  await page.goto(new URL('/__raw_take_test__', base).href)
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required')
    const { default: createVspModule } = await import('/wasm/vsp.js')
    const vsp = await createVspModule()
    for (const name of ['testBarrierArm', 'testBarrierState', 'testBarrierRelease'])
      if (typeof vsp[name] !== 'function') throw new Error(`Missing ${name}: use disposable macro-enabled WASM`)
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const take = () => JSON.parse(vsp.take()).out
    const wait = async (condition, label, ms = 30000) => {
      const end = performance.now() + ms
      while (performance.now() < end) { const value = condition(); if (value) return value; await sleep(10) }
      throw new Error(`Timeout: ${label}; barrier=${vsp.testBarrierState()}`)
    }
    let nextId = 1
    const pending = []
    const collect = () => pending.push(...take())
    const request = async (op, a = '', b = '', value = 0) => {
      const id = nextId++
      vsp.call(id, op, a, b, value)
      const reply = await wait(() => { collect(); return pending.find(m => m.t === 'result' && m.id === id) }, op)
      if (!reply.ok) throw new Error(`${op}: ${JSON.stringify(reply)}`)
      return reply.value
    }
    try {
      await wait(() => { collect(); return pending.some(m => m.type === 'engine_ready') }, 'engine ready', 120000)
      const model = await request('model')
      if (!model.modelEpochValid) throw new Error('Invalid model epoch')
      const cases = []
      for (const phase of [1, 2]) for (const injected of [false, true]) {
        if (injected) await request('guardedWriteInjection', 'watch')
        pending.length = 0
        if (!vsp.testBarrierArm(phase)) throw new Error('Could not arm barrier')
        const id = nextId++
        vsp.callGuarded(id, 'addGeom', 'BLANK', '', 0, model.modelEpoch)
        try {
          await wait(() => vsp.testBarrierState() === 2, `phase ${phase} paused`, 10000)
          const during = []
          // Several raw takes while the engine is stopped; at phase 2 the Watch
          // event is already visible, at phase 1 it is not emitted yet.
          for (let i = 0; i < 10; i++) { during.push(...take()); await sleep(20) }
          if (vsp.testBarrierState() !== 2) throw new Error('Barrier timed out while sampling')
          if (during.some(m => m.t === 'result' && m.id === id)) throw new Error('Result escaped while guard was alive')
          vsp.testBarrierRelease()
          const after = []
          await wait(() => { after.push(...take()); return after.some(m => m.t === 'result' && m.id === id) }, 'released result')
          // A following request fences the engine and detects duplicate results.
          const fenceId = nextId++
          vsp.call(fenceId, 'model', '', '', 0)
          await wait(() => { after.push(...take()); return after.some(m => m.t === 'result' && m.id === fenceId) }, 'result fence')
          cases.push({ phase, injected, id, during, after })
        } finally { vsp.testBarrierRelease() }
      }
      return cases
    } finally { vsp.testBarrierRelease() }
  })
  for (const c of result) {
    const label = `phase=${c.phase}, injected=${c.injected}`
    const all = [...c.during, ...c.after]
    const results = all.filter(m => m.t === 'result' && m.id === c.id)
    assert.equal(results.length, 1, `${label}: exactly one result`)
    assert.equal(results[0].ok, !c.injected, label)
    if (c.injected) {
      assert.equal(results[0].code, 'SCRIPT_REENTRY_BLOCKED', label)
      assert.equal(results[0].outcome, 'unknown', label)
      assert.equal(results[0].actual, null, label)
    }
    const eventIndex = all.findIndex(m => m.type === 'model_changed' && m.label === 'Add BLANK')
    const resultIndex = all.findIndex(m => m.t === 'result' && m.id === c.id)
    assert.ok(eventIndex >= 0 && eventIndex < resultIndex, `${label}: event precedes result`)
    assert.equal(c.during.some(m => m.type === 'model_changed' && m.label === 'Add BLANK'), c.phase === 2, `${label}: event visibility at barrier`)
  }
  assert.deepEqual(errors, [])
  console.log('PASS: raw take excludes staged result at both barriers; Watch precedes unique result, including injected unknown')
} finally {
  if (browser) await browser.close()
  clearTimeout(deadline)
}
