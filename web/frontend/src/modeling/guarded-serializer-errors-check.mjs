// Disposable browser integration test: build WASM with WEBVSP_SCRIPT_GUARD_TEST,
// serve using vite.modeling-test.config.ts, then from web/frontend run:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-serializer-errors-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: serializer test timed out'); process.exit(1) }, 180000)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    const legacy = (op, a = '') => engine.testCall(op, a, '', 0)
    const arm = point => legacy('serializerInjection', point)
    await engine.request('POST', '/file/new')
    const id = (await legacy('addGeom', 'FUSELAGE')).id
    const initial = await legacy('model')
    if (!initial.modelEpochValid) throw new Error('Invalid model epoch')
    const guarded = (op, a = '') => engine.testCallGuarded(op, a, '', 0, initial.modelEpoch)
    const cases = []
    try {
      for (const [op, arg] of [['model', ''], ['bbox', ''], ['bbox', 'all']]) {
        const baseline = await guarded(op, arg)
        if (op === 'model' && !baseline.geoms.some(g => g.id === id)) throw new Error('Missing fixture geom')
        if (op === 'bbox' && (!baseline || !baseline.min || !baseline.max)) throw new Error('Missing fixture bbox')
        for (const phase of ['early', 'middle', 'late']) {
          const point = `${op}:${phase}`
          await arm(point)
          let failure = null
          let value
          try { value = await guarded(op, arg) } catch (e) { failure = e.message }
          const recovery = await guarded(op, arg)
          await arm(point)
          const legacyValue = await legacy(op, arg)
          const legacyRecovery = await guarded(op, arg)
          cases.push({ op, arg, point, baseline, failure, value, recovery, legacyValue, legacyRecovery })
        }
      }
      return cases
    } finally { await arm('clear') }
  })
  assert.deepEqual(errors, [])
  const comparable = (op, value) => op === 'model'
    ? { geoms: value.geoms, active: value.active, vehicleId: value.vehicleId, fileName: value.fileName, version: value.version, modelEpoch: value.modelEpoch }
    : value
  for (const c of result) {
    const label = `${c.point} ${c.arg}`
    assert.match(c.failure ?? '', new RegExp(`Injected serializer error: ${c.point}`), label)
    assert.equal(c.value, undefined, `${label}: must not return partial success`)
    for (const [name, value] of [['recovery', c.recovery], ['legacy', c.legacyValue], ['legacy recovery', c.legacyRecovery]])
      assert.deepEqual(comparable(c.op, value), comparable(c.op, c.baseline), `${label}: ${name}`)
  }
  console.log(`PASS: ${result.length} guarded serializer failures, recovery and legacy compatibility`)
} finally {
  clearTimeout(deadline)
  await browser.close()
}
