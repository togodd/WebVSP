// Disposable integration test on vite.modeling-test.config.ts. Build the WASM with
// WEBVSP_SCRIPT_GUARD_TEST, then run from web/frontend with WEBVSP_TEST_CHROMIUM set.
// Run again against a production WASM with WEBVSP_TEST_PRODUCTION=1 to check exclusion.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const deadline = setTimeout(() => { console.error('FAIL: parameter enumeration test timed out'); process.exit(1) }, 180000)
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const production = process.env.WEBVSP_TEST_PRODUCTION === '1'
  const result = await page.evaluate(async production => {
    const engine = window.__webvspEngine
    const fail = async fn => {
      try { await fn(); return { success: true } }
      catch (e) { return { code: e.code, message: e.message } }
    }
    const arm = (point, message = 'message') => engine.testCall('parmReadInjection', point, message, 0)
    if (production) return { excluded: await fail(() => arm('FindGeoms')) }
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    try {
      await engine.request('POST', '/file/new')
      const geom = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const other = (await engine.request('POST', '/geoms', { type: 'FUSELAGE' })).id
      const identity = (await service.model.getInfo()).identity
      const p = service.parameter
      const xsec = (await p.listSurfaces(geom, identity))[0]?.xsecs[0]
      const otherXsec = (await p.listSurfaces(other, identity))[0]?.xsecs[0]
      if (!xsec || !otherXsec || xsec === otherXsec) throw new Error('Fixture requires distinct cross sections')
      const geomParm = (await p.listGeometryParameterIds(geom, identity))[0]
      const otherParm = (await p.listCrossSectionParameterIds(otherXsec, identity))[0]
      if (!geomParm || !otherParm) throw new Error('Fixture requires linkable parameters')
      const scenarios = [
        ['FindGeoms', 'geomParmIDs', geom, () => p.listGeometryParameterIds(geom, identity)],
        ['FindGeoms', 'xsecParmIDs', xsec, () => p.listCrossSectionParameterIds(xsec, identity)],
        ['FindGeoms', 'geomParm', geom, () => p.getGeometryParameter(geom, geomParm, identity), geomParm],
        ...['FindGeoms', 'GetXSecSurfIDVec', 'GetNumXSec', 'GetXSec'].map(point =>
          [point, 'xsecParm', otherXsec, () => p.getCrossSectionParameter(otherXsec, otherParm, identity), otherParm]),
        ...['GetXSecSurfIDVec', 'GetNumXSec', 'GetXSec'].flatMap(point => [
          [point, 'geomXSecs', geom, () => p.listSurfaces(geom, identity)],
          [point, 'xsecParmIDs', xsec, () => p.listCrossSectionParameterIds(xsec, identity)],
          [point, 'xsecParmIDs', otherXsec, () => p.listCrossSectionParameterIds(otherXsec, identity)],
        ]),
      ]
      const cases = []
      for (const [point, op, owner, facade, parm = ''] of scenarios) for (const message of ['empty', 'message']) {
        const guarded = () => engine.testCallGuarded(op, owner, parm, 0, identity.modelEpoch)
        const legacy = () => engine.testCall(op, owner, parm, 0)
        const baseline = await guarded()
        await arm(point, message)
        const raw = await fail(guarded)
        const recovery = await guarded()
        await arm(point, message)
        const facadeError = await fail(facade)
        const facadeRecovery = await guarded()
        await arm(point, message)
        const legacyValue = await legacy()
        const pending = await fail(guarded) // legacy must neither consume nor trigger the fault
        const afterLegacy = await guarded()
        cases.push({ point, op, message, baseline, raw, recovery, facadeError, facadeRecovery, legacyValue, pending, afterLegacy })
      }
      // A missing XSec forces traversal of every geom: an earlier enumeration
      // failure must win over the eventual CROSS_SECTION_NOT_FOUND diagnosis.
      const missingCases = []
      for (const point of ['GetXSecSurfIDVec', 'GetNumXSec', 'GetXSec']) for (const message of ['empty', 'message']) {
        const read = () => engine.testCallGuarded('xsecParmIDs', 'definitely-not-an-xsec', '', 0, identity.modelEpoch)
        const baseline = await fail(read)
        await arm(point, message)
        const injected = await fail(read)
        const recovery = await fail(read)
        missingCases.push({ point, message, baseline, injected, recovery })
      }
      return { cases, missingCases }
    } finally { await arm('clear'); service.close() }
  }, production)
  assert.deepEqual(pageErrors, [])
  if (production) {
    assert.notEqual(result.excluded.success, true, 'production must reject the test-only hook')
    assert.match(result.excluded.message ?? '', /unknown|unsupported/i)
  } else {
    for (const c of result.cases) {
      const label = `${c.point}/${c.op}/${c.message}`
      for (const error of [c.raw, c.pending]) {
        assert.notEqual(error.success, true, label)
        assert.notEqual(error.code, 'GEOMETRY_NOT_FOUND', label)
        assert.notEqual(error.code, 'CROSS_SECTION_NOT_FOUND', label)
        assert.match(error.message ?? '', c.message === 'empty' ? /no message/ : /Injected parameter enumeration error/, label)
      }
      assert.equal(c.facadeError.code, 'ENGINE_ERROR', label)
      for (const value of [c.recovery, c.facadeRecovery, c.legacyValue, c.afterLegacy]) assert.deepEqual(value, c.baseline, label)
    }
    for (const c of result.missingCases) {
      const label = `missing/${c.point}/${c.message}`
      assert.equal(c.baseline.code, 'CROSS_SECTION_NOT_FOUND', label)
      assert.notEqual(c.injected.success, true, label)
      assert.notEqual(c.injected.code, 'CROSS_SECTION_NOT_FOUND', label)
      assert.match(c.injected.message ?? '', c.message === 'empty' ? /no message/ : /Injected parameter enumeration error/, label)
      assert.deepEqual(c.recovery, c.baseline, label)
    }
    console.log(`PASS: ${result.cases.length} enumeration errors and ${result.missingCases.length} missing-owner errors, recovery and legacy isolation`)

    // The facade's promise resolves only once even if the engine emits duplicate
    // result messages. A separate isolated document owns take() and can count them.
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const rawPage = await context.newPage()
    rawPage.on('pageerror', e => pageErrors.push(e.message))
    await rawPage.route('**/__parameter_raw_test__', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>Disposable raw WASM test</title>',
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' },
    }))
    await rawPage.goto(new URL('/__parameter_raw_test__', process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/').href)
    const rawCases = await rawPage.evaluate(async () => {
      if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required')
      const { default: createVspModule } = await import('/wasm/vsp.js')
      const vsp = await createVspModule()
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const messages = []
      const collect = () => messages.push(...JSON.parse(vsp.take()).out)
      const wait = async (predicate, label, timeout = 30000) => {
        const end = performance.now() + timeout
        while (performance.now() < end) { collect(); if (predicate()) return; await sleep(10) }
        throw new Error(`Timeout: ${label}`)
      }
      let nextId = 1
      const send = async (op, a = '', b = '') => {
        const id = nextId++
        vsp.call(id, op, a, b, 0)
        await wait(() => messages.some(m => m.t === 'result' && m.id === id), op)
        const reply = messages.find(m => m.t === 'result' && m.id === id)
        if (!reply.ok) throw new Error(`${op}: ${JSON.stringify(reply)}`)
        return reply.value
      }
      await wait(() => messages.some(m => m.type === 'engine_ready'), 'engine ready', 120000)
      const geom = (await send('addGeom', 'FUSELAGE')).id
      const model = await send('model')
      if (!model.modelEpochValid) throw new Error('Invalid model epoch')
      const section = (await send('geomXSecs', geom))[0]?.xsecs[0]
      if (!section) throw new Error('Raw fixture has no cross section')
      const cases = []
      for (const point of ['FindGeoms', 'GetXSecSurfIDVec', 'GetNumXSec', 'GetXSec']) for (const message of ['empty', 'message']) {
        await send('parmReadInjection', point, message)
        const id = nextId++
        vsp.callGuarded(id, 'xsecParmIDs', section, '', 0, model.modelEpoch)
        await wait(() => messages.some(m => m.t === 'result' && m.id === id), point)
        await send('model') // FIFO fence captures any extra result from the same request.
        cases.push({ point, message, results: messages.filter(m => m.t === 'result' && m.id === id) })
      }
      return cases
    })
    await context.close()
    for (const c of rawCases) {
      const label = `raw/${c.point}/${c.message}`
      assert.equal(c.results.length, 1, label)
      assert.equal(c.results[0].ok, false, label)
      assert.notEqual(c.results[0].code, 'CROSS_SECTION_NOT_FOUND', label)
      assert.match(c.results[0].error ?? '', c.message === 'empty' ? /no message/ : /Injected parameter enumeration error/, label)
    }
    assert.deepEqual(pageErrors, [])
    console.log(`PASS: ${rawCases.length} injected requests each emit exactly one raw result`)
  }
  if (production) console.log('PASS: production excludes parameter fault injection hook')
} finally { clearTimeout(deadline); await browser.close() }
