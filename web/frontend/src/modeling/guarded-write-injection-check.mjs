// Integration test for a disposable, macro-enabled WASM build, not a production artifact.
// Build with -DWEBVSP_SCRIPT_GUARD_TEST and serve with vite.modeling-test.config.ts.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-write-injection-check.mjs
// Required test-only engine hook: testCall('guardedWriteInjection', phase), where
// phase is pre, post, watch, or clear. It arms one fixed, precompiled script whose
// body adds a BLANK geom. The next guarded write consumes the arm even on early
// failure. The hooks execute under the real write guard, not a simulated result.
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
    const { wasmConnect } = await import('/src/api/wasmEngine.ts')
    const engine = window.__webvspEngine
    const events = []
    const connection = wasmConnect(event => events.push(event), () => {})
    const call = (op, a = '', b = '', value = 0) => engine.testCall(op, a, b, value)
    const arm = phase => call('guardedWriteInjection', phase)
    const failure = async fn => {
      try { await fn(); return { code: 'SUCCEEDED' } }
      catch (e) { return { code: e.code, outcome: e.outcome, actual: e.actual } }
    }
    try {
      await engine.request('POST', '/file/new')
      // A separate fixed script with the same body must actually add a geom without
      // the guard, otherwise blocked injection alone could be a false positive.
      const control = await call('scriptGuardCheck')
      const id = (await call('addGeom', 'FUSELAGE')).id
      const model = await call('model')
      if (!model.modelEpochValid) throw new Error('Invalid model epoch')
      const guarded = (op, a = '', b = '', epoch = model.modelEpoch) => engine.testCallGuarded(op, a, b, 0, epoch)
      const snapshot = async () => ({
        ids: (await guarded('model')).geoms.map(g => g.id),
        origin: await guarded('origin', id),
      })
      const cases = []
      for (const phase of ['pre', 'post', 'watch']) {
        const before = await snapshot()
        await arm(phase)
        const start = events.length
        const error = await failure(() => guarded('move', id, '1,0,0'))
        // The engine emits Watch before its staged result; poll() dispatches both in
        // order. The next queued model request also ensures that batch was processed.
        const after = await snapshot()
        const observed = events.slice(start).filter(e => e.type === 'model_changed' && e.label === 'Move')
        const recoveryBefore = await snapshot()
        const recovery = await guarded('move', id, '1,0,0')
        const recoveryAfter = await snapshot()
        cases.push({ phase, before, error, after, observed, recoveryBefore, recovery, recoveryAfter })
      }
      // A stale epoch must consume an armed injection without running a mutator;
      // the following valid write must not inherit it.
      const beforeStale = await snapshot()
      await arm('pre')
      const stale = await failure(() => guarded('move', id, '1,0,0', 'not-an-epoch'))
      const afterStale = await snapshot()
      const afterStaleWrite = await guarded('move', id, '1,0,0')
      const afterStaleRecovery = await snapshot()
      // Reads and unguarded calls must not consume an armed injection.
      const beforeRead = await snapshot()
      await arm('pre')
      await call('model')
      await snapshot()
      const readThenWrite = await failure(() => guarded('move', id, '1,0,0'))
      const afterRead = await snapshot()
      await arm('pre')
      await arm('clear')
      const clearedWrite = await guarded('move', id, '1,0,0')
      const afterClear = await snapshot()
      // A malformed move fails after epoch validation but before mutation; it too
      // consumes the arm.
      const beforeInvalid = await snapshot()
      await arm('pre')
      await call('model')
      await snapshot()
      const invalid = await failure(() => guarded('move', id, 'bad'))
      const afterInvalid = await snapshot()
      const afterInvalidWrite = await guarded('move', id, '1,0,0')
      const afterInvalidRecovery = await snapshot()
      return { control, id, cases, beforeStale, stale, afterStale, afterStaleWrite, afterStaleRecovery,
        beforeRead, readThenWrite, afterRead, clearedWrite, afterClear,
        beforeInvalid, invalid, afterInvalid, afterInvalidWrite, afterInvalidRecovery }
    } finally {
      try { await arm('clear') } finally { connection.close() }
    }
  })
  const moved = (before, after, delta, label) => {
    assert.deepEqual(after.ids, before.ids, `${label}: injected script must not add a geom`)
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(after.origin[i] - before.origin[i] - (i === 0 ? delta : 0)) < 1e-8, `${label}: axis ${i}`)
  }
  assert.equal(result.control.unguardedRc, 0, 'control script executes')
  assert.equal(result.control.afterUnguarded, result.control.before + 1, 'control script adds a geom')
  assert.equal(result.control.afterCleanup, result.control.before, 'control cleanup')
  for (const c of result.cases) {
    assert.deepEqual(c.error, { code: 'SCRIPT_REENTRY_BLOCKED', outcome: c.phase === 'pre' ? 'not_written' : 'unknown', actual: null }, c.phase)
    moved(c.before, c.after, c.phase === 'pre' ? 0 : 1, c.phase)
    if (c.phase === 'pre') assert.equal(c.observed.length, 0, 'pre: no write Watch')
    else {
      assert.ok(c.observed.length > 0, `${c.phase}: forced Watch must be observable despite failed result`)
      assert.ok(c.observed.some(e => e.changed.includes(result.id)), `${c.phase}: Watch must report the changed geom`)
    }
    assert.equal(c.recovery.ok, true, `${c.phase}: next write succeeds`)
    moved(c.recoveryBefore, c.recoveryAfter, 1, `${c.phase} recovery`)
  }
  assert.deepEqual(result.stale, { code: 'STALE_MODEL', outcome: 'not_written', actual: null })
  moved(result.beforeStale, result.afterStale, 0, 'stale')
  assert.equal(result.afterStaleWrite.ok, true)
  moved(result.afterStale, result.afterStaleRecovery, 1, 'stale recovery')
  assert.deepEqual(result.readThenWrite, { code: 'SCRIPT_REENTRY_BLOCKED', outcome: 'not_written', actual: null })
  moved(result.beforeRead, result.afterRead, 0, 'read preserves arm')
  assert.equal(result.clearedWrite.ok, true)
  moved(result.afterRead, result.afterClear, 1, 'clear')
  assert.deepEqual(result.invalid, { code: 'INVALID_ARGUMENT', outcome: 'not_written', actual: null })
  moved(result.beforeInvalid, result.afterInvalid, 0, 'invalid argument')
  assert.equal(result.afterInvalidWrite.ok, true)
  moved(result.afterInvalid, result.afterInvalidRecovery, 1, 'invalid recovery')
  assert.deepEqual(errors, [])
  console.log('PASS: real WASM guarded pre/post/Watch injection, event delivery, and recovery')
} finally { await browser.close() }
