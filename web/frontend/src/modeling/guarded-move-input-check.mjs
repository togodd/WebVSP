// Run against a freshly rebuilt engine via vite.modeling-test.config.ts.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-move-input-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    const call = (op, a = '', b = '') => engine.testCall(op, a, b, 0)
    await engine.request('POST', '/file/new')
    const id = (await call('addGeom', 'FUSELAGE')).id
    const model = await call('model')
    if (!model.modelEpochValid) throw new Error('Invalid model epoch')
    const guarded = (op, a = '', b = '') => engine.testCallGuarded(op, a, b, 0, model.modelEpoch)
    const snapshot = async () => ({ model: (await guarded('model')).geoms, origin: await guarded('origin', id) })
    const invalid = [
      '', '1', '1,2', '1,2,', ',2,3', '1,,3', '1,2,3,4', '1,2,3,',
      'nan,0,0', 'NaN,0,0', 'inf,0,0', '-Infinity,0,0', '1e999,0,0', '1e9999,0,0', '1e-9999,0,0',
      '1junk,2,3', '1,2,3junk', '1e,2,3',
      ' 1,2,3', '1, 2,3', '1,2,3 ', '1,2,3\n', '1,\t2,3',
    ]
    const failures = []
    for (const input of invalid) {
      const before = await snapshot()
      let failure
      try { await guarded('move', id, input); failure = { code: 'SUCCEEDED' } }
      catch (e) { failure = { code: e.code, outcome: e.outcome, actual: e.actual } }
      failures.push({ input, before, failure, after: await snapshot() })
    }
    const before = await snapshot()
    const moved = await guarded('move', id, '+1.25,-2.5e0,.5')
    const after = await snapshot()
    // Legacy remains permissive: garbage suffix, missing component and whitespace.
    const legacy = await call('move', id, ' 2junk,1')
    const afterLegacy = await snapshot()
    return { failures, before, moved, after, legacy, afterLegacy }
  })
  for (const { input, before, failure, after } of result.failures) {
    assert.deepEqual(failure, { code: 'INVALID_ARGUMENT', outcome: 'not_written', actual: null }, JSON.stringify(input))
    assert.deepEqual(after, before, JSON.stringify(input))
  }
  assert.equal(result.moved.ok, true)
  for (const [i, delta] of [1.25, -2.5, 0.5].entries()) {
    assert.ok(Math.abs(result.after.origin[i] - result.before.origin[i] - delta) < 1e-8)
  }
  assert.equal(result.legacy.ok, true)
  for (const [i, delta] of [2, 1, 0].entries()) {
    assert.ok(Math.abs(result.afterLegacy.origin[i] - result.after.origin[i] - delta) < 1e-8)
  }
  assert.deepEqual(errors, [])
  console.log('PASS: guarded move rejects invalid input without changes; valid and legacy moves work')
} finally { await browser.close() }
