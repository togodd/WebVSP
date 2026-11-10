import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    const model = () => engine.testCall('model')
    const guarded = (token) => engine.testCallGuarded('addGeom', 'WING', '', 0, token)
    const failure = async (fn) => {
      try { await fn(); return null } catch (e) {
        return { code: e.code, status: e.status, outcome: e.outcome, actual: e.actual }
      }
    }
    await engine.request('POST', '/file/new')
    const first = await model()
    const added = await guarded(first.modelEpoch)
    const afterAdd = await model()
    const missing = await failure(() => guarded(undefined))
    const invalid = await failure(() => guarded('00'))
    const afterInvalid = await model()
    // Legacy user requests continue to work and do not replace the model identity.
    const legacy = await engine.request('POST', '/geoms', { type: 'FUSELAGE' })
    const afterLegacy = await model()
    await engine.request('POST', '/file/new')
    const replacement = await model()
    const stale = await failure(() => guarded(first.modelEpoch))
    const afterStale = await model()
    const fresh = await guarded(replacement.modelEpoch)
    const afterFresh = await model()
    return { first, added, afterAdd, missing, invalid, afterInvalid, legacy, afterLegacy, replacement, stale, afterStale, fresh, afterFresh }
  })
  assert.equal(result.first.modelEpochValid, true)
  assert.match(result.first.modelEpoch, /^(0|[1-9]\d*)$/)
  assert.ok(result.added.id)
  assert.equal(result.afterAdd.modelEpoch, result.first.modelEpoch)
  assert.equal(result.afterAdd.geoms.length, result.first.geoms.length + 1)
  assert.equal(result.missing.outcome, 'not_written')
  assert.equal(result.invalid.code, 'STALE_MODEL')
  assert.equal(result.invalid.outcome, 'not_written')
  assert.equal(result.invalid.actual, null)
  assert.deepEqual(result.afterInvalid.geoms, result.afterAdd.geoms)
  assert.ok(result.legacy.id)
  assert.equal(result.afterLegacy.modelEpoch, result.first.modelEpoch)
  assert.equal(result.afterLegacy.geoms.length, result.afterAdd.geoms.length + 1)
  assert.equal(result.replacement.modelEpochValid, true)
  assert.notEqual(result.replacement.modelEpoch, result.first.modelEpoch)
  assert.equal(result.stale.code, 'STALE_MODEL')
  assert.equal(result.stale.outcome, 'not_written')
  assert.equal(result.stale.actual, null)
  assert.deepEqual(result.afterStale.geoms, result.replacement.geoms)
  assert.ok(result.fresh.id)
  assert.equal(result.afterFresh.geoms.length, result.replacement.geoms.length + 1)
  assert.equal(result.afterFresh.modelEpoch, result.replacement.modelEpoch)
  assert.deepEqual(errors, [])
  console.log('PASS: guarded engine model epoch and legacy requests')
} finally { await browser.close() }
