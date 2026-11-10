// Real browser/WASM diagnostic: the 5179 test page must proxy the production WASM,
// not a WEBVSP_SCRIPT_GUARD_TEST build. This exercises the low-level dev hook,
// not the public modeling facade. It creates a new disposable model in its own tab.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-move-semantics-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: diagnostic timed out'); process.exit(1) }, 180000)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine?.testCallGuarded !== 'function') throw new Error('Missing dev-only guarded hook')
    await engine.request('POST', '/file/new')
    const model = await engine.testCall('model', '', '', 0)
    if (!model.modelEpochValid || model.geoms.length !== 0) throw new Error('Expected a valid empty model')
    const guarded = (op, a = '', b = '') => engine.testCallGuarded(op, a, b, 0, model.modelEpoch)
    const id = (await guarded('addGeom', 'BLANK')).id
    if (!id) throw new Error('Failed to create root BLANK')
    const createdModel = await guarded('model')
    const origin = () => guarded('origin', id)
    const move = async delta => {
      const before = await origin()
      const response = await guarded('move', id, delta)
      return { delta, before, response, after: await origin() }
    }
    const tiny = []
    for (const delta of ['0,0,0', '1e-13,0,0', '1e-12,0,0', '-1e-12,0,0']) tiny.push(await move(delta))
    const ordinary = await move('1,2,3')
    // Return to zero, then place X exactly on its documented 1e12 location limit.
    const reset = await move('-1,-2,-3')
    const limit = await move('1e12,0,0')
    const beyond = await move('1,0,0')
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    let facade
    try {
      const info = await service.model.getInfo()
      try {
        await service.write.move({ geometryId: id, frame: 'world', units: 'model-native', delta: [1, 0, 0] }, info.identity)
        facade = { code: 'SUCCEEDED' }
      } catch (error) { facade = { code: error.code } }
    } finally { service.close() }
    return { id, createdModel, tiny, ordinary, reset, limit, beyond, facade, final: await origin() }
  })
  const root = result.createdModel.geoms.find(g => g.id === result.id)
  assert.ok(root, 'created geometry is in model')
  assert.equal(result.createdModel.geoms.length, 1, 'BLANK must be root in an initially empty model')
  for (const test of result.tiny) {
    assert.equal(test.response.ok, true, test.delta)
    assert.deepEqual(test.after, test.before, test.delta)
  }
  assert.equal(result.ordinary.response.ok, true)
  assert.deepEqual(result.ordinary.after.map((n, i) => n - result.ordinary.before[i]), [1, 2, 3])
  assert.equal(result.reset.response.ok, true)
  assert.deepEqual(result.reset.after, [0, 0, 0])
  assert.equal(result.limit.response.ok, true)
  assert.deepEqual(result.limit.after, [1e12, 0, 0])
  assert.equal(result.beyond.response.ok, true)
  assert.deepEqual(result.beyond.after, result.beyond.before)
  assert.equal(result.facade.code, 'UNSUPPORTED_OPERATION')
  assert.deepEqual(result.final, result.beyond.after)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ tiny: result.tiny, ordinary: result.ordinary, limit: result.limit, beyond: result.beyond, facade: result.facade }, null, 2))
  console.log('PASS: guarded low-level move ok does not imply origin changed; facade move remains disabled')
} finally { await browser.close(); clearTimeout(deadline) }
