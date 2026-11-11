// Production WASM, dev test page (not an instrumented WASM). Uses a disposable browser model.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-add-negative-check.mjs
// Optional WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: guarded add test timed out'); process.exit(1) }, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine?.testCallGuarded !== 'function') throw new Error('Missing dev-only guarded bridge')
    const call = (op, a = '', b = '') => engine.testCall(op, a, b, 0)
    const guarded = (epoch, op, a = '', b = '') => engine.testCallGuarded(op, a, b, 0, epoch)
    await engine.request('POST', '/file/new')
    const initial = await call('model')
    if (!initial.modelEpochValid || initial.geoms.length) throw new Error('Expected a valid empty disposable model')
    const epoch = initial.modelEpoch
    const id = (await guarded(epoch, 'addGeom', 'BLANK')).id
    if (!id) throw new Error('Positive control failed to create BLANK')
    await call('pick', id)
    const snapshot = () => call('model')
    const selected = await snapshot()
    if (!selected.active.includes(id)) throw new Error('Positive control failed to select BLANK')
    const attempt = async (label, type, parent, expectedEpoch) => {
      const before = await snapshot()
      let response
      try { response = { ok: true, value: await guarded(expectedEpoch, 'addGeom', type, parent) } }
      catch (e) { response = { ok: false, message: e.message, code: e.code ?? null, outcome: e.outcome ?? null, actual: e.actual ?? null } }
      return { label, before, response, after: await snapshot() }
    }
    const badType = await attempt('invalid type', '__INVALID_GEOM_TYPE__', '', epoch)
    const badParent = await attempt('invalid parent', 'BLANK', '__INVALID_PARENT__', epoch)
    const stale = await attempt('stale epoch', 'BLANK', '', (BigInt(epoch) + 1n).toString())
    // A top-level conformal may fail after entering AddGeom, or succeed depending on OpenVSP.
    const conformal = await attempt('optional top-level conformal', 'CONFORMAL', '', epoch)
    return { id, epoch, badType, badParent, stale, conformal }
  })
  const summarize = ({ before, after }) => ({
    model: { changed: JSON.stringify(before.geoms) !== JSON.stringify(after.geoms), before: before.geoms, after: after.geoms },
    selection: { changed: JSON.stringify(before.active) !== JSON.stringify(after.active), before: before.active, after: after.active },
    epoch: { changed: before.modelEpoch !== after.modelEpoch || before.modelEpochValid !== after.modelEpochValid, before: [before.modelEpoch, before.modelEpochValid], after: [after.modelEpoch, after.modelEpochValid] },
    otherModelFields: Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !['geoms', 'active', 'modelEpoch', 'modelEpochValid'].includes(k)).map(k => [k, { changed: JSON.stringify(before[k]) !== JSON.stringify(after[k]), before: before[k], after: after[k] }])),
  })
  for (const test of [result.badType, result.badParent, result.stale, result.conformal]) {
    console.log(JSON.stringify({ label: test.label, response: test.response, diff: summarize(test) }, null, 2))
  }
  for (const test of [result.badType, result.badParent, result.stale]) {
    assert.equal(test.response.ok, false, test.label)
    assert.equal(test.response.outcome, 'not_written', test.label)
    assert.equal(test.response.actual, null, test.label)
    assert.deepEqual(test.after.geoms, test.before.geoms, `${test.label}: model geoms`)
    assert.deepEqual(test.after.active, test.before.active, `${test.label}: selection`)
    assert.equal(test.after.modelEpoch, test.before.modelEpoch, `${test.label}: epoch`)
    assert.equal(test.after.modelEpochValid, test.before.modelEpochValid, `${test.label}: epoch validity`)
  }
  assert.equal(result.badType.response.code, 'UNSAFE_SCRIPT_CONTEXT')
  assert.equal(result.stale.response.code, 'STALE_MODEL')
  assert.equal(result.conformal.after.modelEpoch, result.conformal.before.modelEpoch)
  assert.equal(result.conformal.after.modelEpochValid, result.conformal.before.modelEpochValid)
  if (!result.conformal.response.ok) {
    // Once AddGeom starts, outcome is unknown: do not claim rollback; record exact model/selection differences above.
    assert.ok(['unknown', 'not_written'].includes(result.conformal.response.outcome))
    assert.equal(result.conformal.response.actual, null)
  } else {
    assert.ok(result.conformal.response.value.id, 'successful conformal must return an ID')
    assert.ok(result.conformal.after.geoms.some(g => g.id === result.conformal.response.value.id))
  }
  assert.deepEqual(errors, [])
  console.log('PASS: guarded add negative production-WASM checks')
} finally { if (browser) await browser.close(); clearTimeout(deadline) }
