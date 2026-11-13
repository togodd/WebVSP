// Real ErrorMgr empty-description write faults in a disposable test-macro WASM.
// Serve a dedicated loopback Vite instance with a disposable model and WASM.
// Set WEBVSP_TEST_PAGE to its HTTP origin root, WEBVSP_TEST_CHROMIUM to Chrome,
// and WEBVSP_TEST_TOKEN to random hex (at least 32 characters). The server must
// return exactly that token at /__guarded_write_errors_test_token; do not use an
// existing user-facing server. A matching marker identifies the intended instance.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
if (!process.env.WEBVSP_TEST_PAGE) throw new Error('Set WEBVSP_TEST_PAGE to a dedicated loopback test server')
const testUrl = new URL(process.env.WEBVSP_TEST_PAGE)
if (testUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(testUrl.hostname) || testUrl.username || testUrl.password || testUrl.pathname !== '/' || testUrl.search || testUrl.hash)
  throw new Error('Test page must be a loopback HTTP origin root')
const token = process.env.WEBVSP_TEST_TOKEN
if (!token || !/^[0-9a-f]{32,}$/.test(token)) throw new Error('Set WEBVSP_TEST_TOKEN to a random hexadecimal token of at least 32 characters')
const marker = await fetch(new URL('/__guarded_write_errors_test_token', testUrl), { redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store' })
if (!marker.ok || (await marker.text()).trim() !== token) throw new Error('Disposable test server token mismatch')
const deadline = setTimeout(() => { console.error('FAIL: write error test timed out'); process.exit(1) }, 180000)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(testUrl.href)
  if (page.url() !== testUrl.href) throw new Error('Test server redirected away from the verified origin')
  const browserMarker = await page.evaluate(async () => {
    const response = await fetch('/__guarded_write_errors_test_token', { cache: 'no-store', redirect: 'error' })
    return response.ok ? (await response.text()).trim() : null
  })
  if (browserMarker !== token) throw new Error('Browser test server token mismatch')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const cases = await page.evaluate(async () => {
    const e = window.__webvspEngine
    const call = (op, a = '', b = '', value = 0) => e.testCall(op, a, b, value)
    const arm = (point, mode = 'empty') => call('guardedWriteErrorInjection', point, mode)
    await e.request('POST', '/file/new')
    const model = await call('model')
    const write = (op, a = '', b = '', value = 0, epoch = model.modelEpoch) => e.testCallGuarded(op, a, b, value, epoch)
    const id = (await write('addGeom', 'FUSELAGE')).id
    const parm = await write('fuselageLength', id)
    let section, sectionParm
    for (const surface of await write('geomXSecs', id)) {
      for (const xsec of surface.xsecs) {
        for (const parmId of await write('xsecParmIDs', xsec)) {
          const p = await write('xsecParm', xsec, parmId)
          // All xsec cases cumulatively increase this parm by about 3.6;
          // reserve extra headroom so later writes cannot clamp at the limit.
          if (p.active && p.type === 0 && Number.isFinite(p.value) && p.value + 5 < p.upperLimit) {
            section = xsec; sectionParm = p; break
          }
        }
        if (section) break
      }
      if (section) break
    }
    if (!section) throw new Error('No suitable active cross-section double parm')
    const snapshot = async () => {
      const model = await write('model')
      return { model, ids: model.geoms.map(g => g.id), length: (await write('geomParm', id, parm.id)).value, section: (await write('xsecParm', section, sectionParm.id)).value, origin: await write('origin', id) }
    }
    const attempt = async fn => { try { return { value: await fn() } } catch (err) { return { error: { message: err.message, code: err.code, outcome: err.outcome, actual: err.actual } } } }
    const out = []
    try {
      for (const point of ['FindGeoms', 'metadata', 'setter', 'readback', 'addUpdate', 'move']) {
        for (const mode of ['empty', 'mixed']) {
          const before = await snapshot()
          const op = point === 'addUpdate' ? 'addGeom' : point === 'move' ? 'move' : 'geomSetParm'
          const args = op === 'addGeom' ? ['BLANK', '', 0] : op === 'move' ? [id, '1,0,0', 0] : [id, parm.id, before.length + 1]
          await arm(point, mode)
          const result = await attempt(() => write(op, ...args))
          const after = await snapshot()
          const recoveryArgs = op === 'geomSetParm' ? [id, parm.id, after.length + 1] : args
          const recovery = await attempt(() => write(op, ...recoveryArgs))
          const recovered = await snapshot()
          out.push({ point, mode, before, args, result, after, recoveryArgs, recovery, recovered })
        }
      }
      for (const mode of ['empty', 'mixed']) {
        const before = await snapshot()
        const args = [id, parm.id, before.length + 1]
        await arm('GetGeomParmIDs', mode)
        const result = await attempt(() => write('geomSetParm', ...args))
        const after = await snapshot()
        const recoveryArgs = [id, parm.id, before.length + 2]
        const recovery = await attempt(() => write('geomSetParm', ...recoveryArgs))
        const recovered = await snapshot()
        out.push({ point: 'GetGeomParmIDs', mode, geom: true, before, args, result, after, recoveryArgs, recovery, recovered })
      }
      for (const point of ['GetXSecSurfIDVec', 'GetNumXSec', 'GetXSec', 'GetXSecParmIDs']) {
        for (const mode of ['empty', 'mixed']) {
          const before = await snapshot()
          const args = [section, sectionParm.id, before.section + 0.1]
          await arm(point, mode)
          const result = await attempt(() => write('xsecSetParm', ...args))
          const after = await snapshot()
          const recoveryArgs = [section, sectionParm.id, before.section + 0.2]
          const recovery = await attempt(() => write('xsecSetParm', ...recoveryArgs))
          const recovered = await snapshot()
          out.push({ point, mode, xsec: true, before, args, result, after, recoveryArgs, recovery, recovered })
        }
      }
      for (const point of ['metadata', 'setter', 'readback']) {
        for (const mode of ['empty', 'mixed']) {
          const before = await snapshot()
          const args = [section, sectionParm.id, before.section + 0.1]
          await arm(point, mode)
          const result = await attempt(() => write('xsecSetParm', ...args))
          const after = await snapshot()
          const recoveryArgs = [section, sectionParm.id, after.section + 0.2]
          const recovery = await attempt(() => write('xsecSetParm', ...recoveryArgs))
          const recovered = await snapshot()
          out.push({ point, mode, xsecWrite: true, before, args, result, after, recoveryArgs, recovery, recovered })
        }
      }
      for (const mode of ['empty', 'mixed']) {
        const before = await snapshot()
        const expectedIds = await write('xsecParmIDs', section)
        const args = [section, sectionParm.id, before.section + 0.1]
        await arm('GetXSecParmIDs', mode)
        const read = await attempt(() => write('xsecParmIDs', section))
        const result = await attempt(() => write('xsecSetParm', ...args))
        const after = await snapshot()
        const recoveryArgs = [section, sectionParm.id, before.section + 0.2]
        const recovery = await attempt(() => write('xsecSetParm', ...recoveryArgs))
        const recovered = await snapshot()
        out.push({ control: 'xsec-read-preserves-arm', mode, before, expectedIds, read, args, result, after, recoveryArgs, recovery, recovered })
      }
      for (const control of ['miss', 'stale', 'clear', 'legacy']) {
        const before = await snapshot()
        await arm(control === 'miss' ? 'setter' : 'move')
        let first
        if (control === 'miss') first = await attempt(() => write('move', id, '1,0,0'))
        if (control === 'stale') first = await attempt(() => write('move', id, '1,0,0', 0, 'bad'))
        if (control === 'clear') { await arm('clear'); first = await attempt(() => write('move', id, '1,0,0')) }
        if (control === 'legacy') first = await attempt(() => call('move', id, '1,0,0'))
        const after = await snapshot()
        if (control === 'miss') {
          // Exercise the armed point itself: a second move cannot prove the
          // unmatched setter arm was consumed by the first guarded write.
          const recoveryArgs = [id, parm.id, after.length + 1]
          const recovery = await attempt(() => write('geomSetParm', ...recoveryArgs))
          const recovered = await snapshot()
          await arm('setter')
          const injectedArgs = [id, parm.id, recovered.length + 1]
          const injected = await attempt(() => write('geomSetParm', ...injectedArgs))
          const afterInjected = await snapshot()
          out.push({ control, before, first, after, recoveryArgs, recovery, recovered, injectedArgs, injected, afterInjected })
          continue
        }
        const legacyInjected = control === 'legacy' ? await attempt(() => write('move', id, '1,0,0')) : null
        const afterLegacyInjected = control === 'legacy' ? await snapshot() : null
        const recovery = await attempt(() => write('move', id, '1,0,0'))
        const recovered = await snapshot()
        out.push({ control, before, first, after, legacyInjected, afterLegacyInjected, recovery, recovered })
      }
      // A real unsafe context must consume the one-shot arm even though move
      // returns before reaching its injection point.
      const before = await snapshot()
      const fixture = await call('scriptPreflightFixture', 'advlink')
      await arm('move')
      const first = await attempt(() => write('move', id, '1,0,0'))
      const after = await snapshot()
      await call('scriptPreflightFixture', 'cleanup')
      const recovery = await attempt(() => write('move', id, '1,0,0'))
      const recovered = await snapshot()
      await arm('move')
      const injected = await attempt(() => write('move', id, '1,0,0'))
      const afterInjected = await snapshot()
      out.push({ control: 'unsafe', fixture, before, first, after, recovery, recovered, injected, afterInjected })
      return out
    } finally {
      try { await call('scriptPreflightFixture', 'cleanup') } finally { await arm('clear') }
    }
  })
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-8, `${label}: ${a} != ${b}`)
  for (const c of cases) {
    const label = `${c.point ?? c.control}/${c.mode ?? 'control'}`
    if (c.control === 'xsec-read-preserves-arm') {
      assert.ok(c.expectedIds.includes(c.args[1]), `${label}: selected parm belongs to section`)
      assert.deepEqual(c.read, { value: c.expectedIds }, `${label}: guarded read succeeds with exact IDs`)
      assert.equal(c.result.error?.outcome, 'not_written', label)
      assert.equal(c.result.error.actual, null, label)
      assert.equal(c.result.error.message, c.mode === 'mixed' ? 'Injected write error; OpenVSP API error (no message)' : 'OpenVSP API error (no message)', label)
      assert.deepEqual(c.after, c.before, `${label}: failed write leaves model unchanged`)
      near(c.recovery.value?.actual, c.recoveryArgs[2], `${label}: recovery result`)
      near(c.recovered.section, c.recoveryArgs[2], `${label}: recovery value`)
      assert.deepEqual(c.recovered.ids, c.after.ids, label)
      near(c.recovered.length, c.after.length, label)
      assert.deepEqual(c.recovered.origin, c.after.origin, label)
      continue
    }
    if (c.control === 'unsafe') {
      assert.deepEqual(c.fixture, { kind: 'advlink', id: '', detached: false }, label)
      assert.equal(c.first.error?.code, 'UNSAFE_SCRIPT_CONTEXT', label)
      assert.equal(c.first.error?.outcome, 'not_written', label)
      assert.equal(c.first.error?.actual, null, label)
      assert.deepEqual(c.after, c.before, `${label}: unsafe move leaves model unchanged`)
      assert.ok(c.recovery.value?.ok, `${label}: arm consumed by unsafe move`)
      near(c.recovered.origin[0], c.after.origin[0] + 1, label)
      assert.equal(c.injected.error?.outcome, 'unknown', label)
      assert.equal(c.injected.error?.actual, null, label)
      assert.equal(c.injected.error?.message, 'OpenVSP API error (no message)', label)
      near(c.afterInjected.origin[0], c.recovered.origin[0] + 1, label)
      continue
    }
    if (c.control === 'miss') {
      assert.ok(c.first.value?.ok, label)
      near(c.after.origin[0], c.before.origin[0] + 1, label)
      near(c.after.length, c.before.length, label)
      near(c.recovery.value?.actual, c.recoveryArgs[2], `${label}: unmatched arm consumed`)
      near(c.recovered.length, c.recoveryArgs[2], `${label}: setter succeeded`)
      assert.equal(c.injected.error?.outcome, 'unknown', `${label}: re-armed setter fires`)
      assert.equal(c.injected.error?.message, 'SetParmValUpdate failed: OpenVSP API error (no message)', label)
      near(c.injected.error?.actual, c.injectedArgs[2], label)
      near(c.afterInjected.length, c.injectedArgs[2], `${label}: injected setter has side effect`)
      assert.deepEqual(c.afterInjected.ids, c.recovered.ids, label)
      assert.deepEqual(c.afterInjected.origin, c.recovered.origin, label)
      near(c.afterInjected.section, c.recovered.section, label)
      continue
    }
    if (c.control) {
      if (c.control === 'stale') assert.equal(c.first.error?.code, 'STALE_MODEL', label)
      else assert.ok(c.first.value?.ok, label)
      near(c.after.origin[0], c.before.origin[0] + (c.control === 'stale' ? 0 : 1), label)
      if (c.control === 'legacy') {
        assert.equal(c.legacyInjected.error?.outcome, 'unknown', label)
        assert.equal(c.legacyInjected.error.message, 'OpenVSP API error (no message)', label)
        near(c.afterLegacyInjected.origin[0], c.after.origin[0] + 1, label)
      }
      assert.ok(c.recovery.value?.ok, label)
      near(c.recovered.origin[0], (c.afterLegacyInjected ?? c.after).origin[0] + 1, label)
      continue
    }
    if (c.geom) {
      assert.equal(c.result.error?.outcome, 'not_written', label)
      assert.equal(c.result.error.actual, null, label)
      assert.equal(c.result.error.message, c.mode === 'mixed' ? 'Injected write error; OpenVSP API error (no message)' : 'OpenVSP API error (no message)', label)
      assert.deepEqual(c.after, c.before, `${label}: model and observed parameters unchanged`)
      near(c.recovery.value?.actual, c.recoveryArgs[2], `${label}: recovery result`)
      near(c.recovered.length, c.recoveryArgs[2], `${label}: recovery value`)
      assert.deepEqual(c.recovered.ids, c.after.ids, `${label}: recovery preserves geom IDs`)
      near(c.recovered.section, c.after.section, label)
      assert.deepEqual(c.recovered.origin, c.after.origin, label)
      continue
    }
    if (c.xsecWrite) {
      const pre = c.point === 'metadata'
      const message = c.mode === 'mixed' ? 'Injected write error; OpenVSP API error (no message)' : 'OpenVSP API error (no message)'
      const prefix = pre ? 'Cannot read parm metadata: ' : c.point === 'setter' ? 'SetParmValUpdate failed: ' : 'Readback failed: '
      assert.equal(c.result.error?.outcome, pre ? 'not_written' : 'unknown', label)
      assert.equal(c.result.error.message, prefix + message, label)
      if (c.point === 'setter') near(c.result.error.actual, c.args[2], `${label}: setter actual`)
      else assert.equal(c.result.error.actual, null, label)
      near(c.after.section, pre ? c.before.section : c.args[2], `${label}: observed section`)
      assert.deepEqual(c.after.ids, c.before.ids, label)
      near(c.after.length, c.before.length, label)
      assert.deepEqual(c.after.origin, c.before.origin, label)
      near(c.recovery.value?.actual, c.recoveryArgs[2], `${label}: recovery result`)
      near(c.recovered.section, c.recoveryArgs[2], `${label}: recovery observation`)
      assert.deepEqual(c.recovered.ids, c.after.ids, label)
      near(c.recovered.length, c.after.length, label)
      assert.deepEqual(c.recovered.origin, c.after.origin, label)
      continue
    }
    if (c.xsec) {
      assert.equal(c.result.error?.outcome, 'not_written', label)
      assert.equal(c.result.error.actual, null, label)
      assert.equal(c.result.error.message, c.mode === 'mixed' ? 'Injected write error; OpenVSP API error (no message)' : 'OpenVSP API error (no message)', label)
      assert.deepEqual(c.after, c.before, `${label}: model and observed parameters unchanged`)
      near(c.recovery.value?.actual, c.recoveryArgs[2], `${label}: recovery result`)
      near(c.recovered.section, c.recoveryArgs[2], `${label}: recovery value`)
      assert.deepEqual(c.recovered.ids, c.after.ids, `${label}: recovery preserves geom IDs`)
      near(c.recovered.length, c.after.length, label)
      continue
    }
    const pre = c.point === 'FindGeoms' || c.point === 'metadata'
    assert.equal(c.result.error?.outcome, pre ? 'not_written' : 'unknown', label)
    const expectedMessage = c.mode === 'mixed' ? 'Injected write error; OpenVSP API error (no message)' : 'OpenVSP API error (no message)'
    const prefix = c.point === 'metadata' ? 'Cannot read parm metadata: ' : c.point === 'setter' ? 'SetParmValUpdate failed: ' : c.point === 'readback' ? 'Readback failed: ' : ''
    assert.equal(c.result.error.message, prefix + expectedMessage, label)
    if (c.point === 'setter') near(c.result.error.actual, c.args[2], label)
    else assert.equal(c.result.error.actual, null, label)
    assert.equal(c.after.ids.length - c.before.ids.length, c.point === 'addUpdate' ? 1 : 0, label)
    near(c.after.length, ['setter', 'readback'].includes(c.point) ? c.args[2] : c.before.length, label)
    near(c.after.origin[0], c.before.origin[0] + (c.point === 'move' ? 1 : 0), label)
    assert.ok(c.recovery.value, `${label}: recovery succeeds`)
    assert.equal(c.recovered.ids.length - c.after.ids.length, c.point === 'addUpdate' ? 1 : 0, label)
    near(c.recovered.length, ['FindGeoms', 'metadata', 'setter', 'readback'].includes(c.point) ? c.recoveryArgs[2] : c.after.length, label)
    near(c.recovered.origin[0], c.after.origin[0] + (c.point === 'move' ? 1 : 0), label)
  }
  assert.deepEqual(errors, [])
  console.log(`PASS: ${cases.length} guarded write error and recovery cases`)
} finally { await browser.close(); clearTimeout(deadline) }
