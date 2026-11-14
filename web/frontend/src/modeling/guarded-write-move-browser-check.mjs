// Disposable browser/WASM integration test of the isolated write service, not the
// public write facade. Serve a production WASM via the modeling test page.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-write-move-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: write move browser check timed out'); process.exit(1) }, 180000)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  // A fresh browser context and model keep this test away from a user's model.
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine?.testCallGuarded !== 'function') throw new Error('Missing dev-only guarded hook')
    const { createWriteService } = await import('/src/modeling/writeService.ts')
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    await engine.request('POST', '/file/new')
    const initial = await engine.testCall('model', '', '', 0)
    if (!initial.modelEpochValid || initial.geoms.length !== 0) throw new Error('Expected a valid empty model')
    const guarded = (op, a = '', b = '', value = 0) => engine.testCallGuarded(op, a, b, value, initial.modelEpoch)
    const id = (await guarded('addGeom', 'BLANK')).id
    const model = await guarded('model')
    if (!id || model.geoms.length !== 1 || model.geoms[0].id !== id || model.geoms[0].parent !== null) throw new Error('Expected one root BLANK')
    const facade = createBrowserModelingService()
    try {
      const identity = (await facade.model.getInfo()).identity
      if (identity.modelEpoch !== initial.modelEpoch) throw new Error('Model identity changed')
      const writes = []
      const checkIdentity = token => { if (token?.sessionId !== identity.sessionId || token?.modelEpoch !== identity.modelEpoch || token === identity) throw new Error('Identity snapshot not forwarded') }
      const adapter = {
        model: token => { checkIdentity(token); return guarded('model') },
        geomTypes: () => guarded('geomTypes'),
        addGeom: (type, parent) => guarded('addGeom', type, parent ?? ''),
        geomOrigin: (geomId, token) => { checkIdentity(token); return guarded('origin', geomId) },
        moveGeoms: async (ids, delta, token) => {
          checkIdentity(token)
          const response = await guarded('move', ids.join(','), delta.join(','))
          writes.push({ ids, delta, response })
          return response
        },
      }
      const service = createWriteService(adapter)
      const origin = () => guarded('origin', id)
      const attempt = async delta => {
        const before = await origin()
        const start = writes.length
        let outcome
        try { outcome = { result: await service.move({ geometryId: id, frame: 'world', units: 'model-native', delta }, identity) } }
        catch (error) { outcome = { code: error.code } }
        return { before, after: await origin(), outcome, writes: writes.slice(start) }
      }
      const tiny = await attempt([1e-13, 0, 0])
      const ordinary = await attempt([1, 2, 3])
      const reset = await guarded('move', id, '-1,-2,-3')
      const resetOrigin = await origin()
      const limit = await guarded('move', id, '1e12,0,0')
      const limitOrigin = await origin()
      const clamp = await attempt([1, 0, 0])
      return { id, tiny, ordinary, reset, resetOrigin, limit, limitOrigin, clamp, final: await origin() }
    } finally { facade.close() }
  })
  for (const [label, test] of [['tiny', result.tiny], ['clamp', result.clamp]]) {
    assert.equal(test.outcome.code, 'OUTCOME_UNKNOWN', label)
    assert.equal(test.writes.length, 1, `${label}: exactly one dispatch, no retry`)
    assert.equal(test.writes[0].response.ok, true, `${label}: engine accepted the request`)
    assert.deepEqual(test.writes[0].ids, [result.id], label)
    assert.deepEqual(test.after, test.before, `${label}: actual origin did not change`)
  }
  assert.deepEqual(result.tiny.before, [0, 0, 0])
  assert.deepEqual(result.ordinary.before, [0, 0, 0])
  assert.deepEqual(result.ordinary.after, [1, 2, 3])
  assert.deepEqual(result.ordinary.outcome.result, { geometryId: result.id, origin: [1, 2, 3] })
  assert.equal(result.ordinary.writes.length, 1)
  assert.equal(result.ordinary.writes[0].response.ok, true)
  assert.equal(result.reset.ok, true)
  assert.deepEqual(result.resetOrigin, [0, 0, 0])
  assert.equal(result.limit.ok, true)
  assert.deepEqual(result.limitOrigin, [1e12, 0, 0])
  assert.deepEqual(result.clamp.before, result.limitOrigin)
  assert.deepEqual(result.final, result.clamp.after)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(result, null, 2))
  console.log('PASS: isolated write service verifies real guarded moves; clamped moves report unknown without retry')
} finally { await browser.close(); clearTimeout(deadline) }
