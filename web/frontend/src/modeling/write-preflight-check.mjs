// Disposable, isolated WASM build with -DWEBVSP_SCRIPT_GUARD_TEST only; do not deploy it.
// Start vite.modeling-test.config.ts with WEBVSP_TEST_WASM_ORIGIN pointing at that build.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/write-preflight-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    // Use the app's own engine instance even when Vite adds HMR query strings.
    // The dev hook submits through the same callGuarded WASM entry point.
    const callGuarded = engine.testCallGuarded
    const call = (op, a = '', b = '', value = 0) => engine.testCall(op, a, b, value)
    const fixture = mode => call('scriptPreflightFixture', mode)
    const model = () => call('model')
    const fail = async f => {
      try { await f(); return { code: 'SUCCEEDED' } }
      catch (e) { return { code: e.code, outcome: e.outcome, actual: e.actual } }
    }
    await engine.request('POST', '/file/new')
    const body = (await call('addGeom', 'FUSELAGE')).id
    const first = await model()
    if (!first.modelEpochValid) throw new Error(`Invalid fixture model epoch: ${JSON.stringify(first)}`)
    const epoch = first.modelEpoch
    const guarded = async (op, a = '', b = '', value = 0, token = epoch) => {
      try { return await callGuarded(op, a, b, value, token) }
      catch (e) { if (e.code === 'STALE_MODEL' && token === epoch) e.message += ` during ${op}; expected ${epoch}, current ${(await model()).modelEpoch}`; throw e }
    }
    const length = await guarded('fuselageLength', body)
    const surfaces = await guarded('geomXSecs', body)
    // Select a normal, active double whose value can be incremented without hitting a limit.
    let section, sectionParm
    for (const surface of surfaces) {
      for (const xsec of surface.xsecs) {
        for (const id of await guarded('xsecParmIDs', xsec)) {
          const p = await guarded('xsecParm', xsec, id)
          if (p.active && p.type === 0 && Number.isFinite(p.value) && p.value + 0.1 < p.upperLimit) {
            section = xsec; sectionParm = p; break
          }
        }
        if (section) break
      }
      if (section) break
    }
    if (!section) throw new Error('No suitable active double cross-section parameter')
    const snapshot = async () => ({
      geoms: (await guarded('model')).geoms,
      origin: await guarded('origin', body),
      length: (await guarded('geomParm', body, length.id)).value,
      section: (await guarded('xsecParm', section, sectionParm.id)).value,
    })
    const normal = {}
    normal.before = await snapshot()
    normal.add = await guarded('addGeom', 'BLANK')
    normal.move = await guarded('move', body, '1,0,0')
    normal.geom = await guarded('geomSetParm', body, length.id, length.value + 1)
    normal.xsec = await guarded('xsecSetParm', section, sectionParm.id, sectionParm.value + 0.1)
    normal.after = await snapshot()
    const attempts = async () => {
      const before = await snapshot()
      const failures = []
      for (const args of [
        ['addGeom', 'BLANK', '', 0], ['move', body, '2,0,0', 0],
        ['geomSetParm', body, length.id, length.value + 2],
        ['xsecSetParm', section, sectionParm.id, sectionParm.value + 0.2],
      ]) failures.push(await fail(() => guarded(...args)))
      const after = await snapshot()
      return { before, failures, after }
    }
    const cases = []
    try {
      for (let run = 0; run < 2; run++) {
        const adv = await fixture('advlink')
        const advRejected = await attempts()
        const stale = await fail(() => guarded('addGeom', 'BLANK', '', 0, '99999999999999999999'))
        const legacy = await call('addGeom', 'BLANK')
        const afterLegacy = await model()
        await fixture('cleanup')
        const custom = await fixture('custom-detached')
        const customRejected = await attempts()
        await fixture('cleanup')
        const recovered = await guarded('addGeom', 'BLANK')
        cases.push({ adv, advRejected, stale, legacy, afterLegacy, custom, customRejected, recovered })
      }
    } finally { await fixture('cleanup') }
    return { first, length, sectionParm, normal, cases }
  })
  assert.equal(result.first.modelEpochValid, true)
  assert.ok(result.normal.add.id)
  assert.equal(result.normal.move.ok, true)
  assert.equal(result.normal.geom.actual, result.length.value + 1)
  assert.ok(Math.abs(result.normal.xsec.actual - (result.sectionParm.value + 0.1)) < 1e-8)
  assert.equal(result.normal.after.length, result.length.value + 1)
  assert.ok(Math.abs(result.normal.after.section - (result.sectionParm.value + 0.1)) < 1e-8)
  assert.equal(result.normal.after.geoms.length, result.normal.before.geoms.length + 1)
  assert.ok(Math.abs(result.normal.after.origin[0] - result.normal.before.origin[0] - 1) < 1e-8)
  for (const c of result.cases) {
    assert.equal(c.adv.kind, 'advlink')
    assert.equal(c.adv.id, '')
    assert.equal(c.adv.detached, false)
    for (const test of [c.advRejected, c.customRejected]) {
      assert.deepEqual(test.after, test.before)
      assert.deepEqual(test.failures, Array(4).fill({ code: 'UNSAFE_SCRIPT_CONTEXT', outcome: 'not_written', actual: null }))
    }
    assert.equal(c.stale.code, 'STALE_MODEL')
    assert.equal(c.stale.outcome, 'not_written')
    assert.ok(c.legacy.id)
    assert.ok(c.afterLegacy.geoms.some(g => g.id === c.legacy.id))
    assert.equal(c.custom.kind, 'custom-detached')
    assert.equal(c.custom.detached, true)
    assert.ok(c.custom.id)
    assert.ok(!c.customRejected.before.geoms.some(g => g.id === c.custom.id))
    assert.ok(c.recovered.id)
  }
  assert.deepEqual(errors, [])
  console.log('PASS: guarded write preflight, detached custom, AdvLink, and legacy behavior')
} finally { await browser.close() }
