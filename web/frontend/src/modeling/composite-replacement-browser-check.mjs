// Browser-only integration check. Requires isolated test server :5179 with matching WASM.
// WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/composite-replacement-browser-check.mjs
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
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const { createWingService } = await import('/src/modeling/wingService.ts')
    const { createFuselageService } = await import('/src/modeling/fuselageService.ts')
    const service = createBrowserModelingService()
    window.__case = { service, createWingService, createFuselageService }
  })
  for (const kind of ['wing', 'fuselage']) {
    // Every adapter operation calls the production guarded facade, and therefore the
    // ordinary wasm bridge; only the pre-XSec JS scheduling barrier is test-specific.
    const setup = await page.evaluate(async kind => {
      const c = window.__case, engine = window.__webvspEngine
      await engine.request('POST', '/file/new')
      const id = (await engine.request('POST', '/geoms', { type: kind.toUpperCase() })).id
      const identity = (await c.service.model.getInfo()).identity
      c.trace = []; c.release = null
      const gate = new Promise(resolve => { c.release = resolve })
      const geometry = { get: async (id, token) => {
        c.trace.push('geometry:start')
        const value = await c.service.geometry.get(id, token)
        c.trace.push('geometry:done')
        return value
      } }
      const parameter = {
        getFuselageLength: async (id, token) => {
          c.trace.push('length:start')
          const value = await c.service.parameter.getFuselageLength(id, token)
          c.trace.push('length:done')
          return value
        },
        listSurfaces: async (id, token) => {
          c.trace.push('xsec:waiting')
          await gate
          c.trace.push('xsec:dispatch')
          try {
            const value = await c.service.parameter.listSurfaces(id, token)
            c.trace.push('xsec:success')
            return value
          } catch (e) { c.trace.push(`xsec:error:${e.code}`); throw e }
        },
      }
      const composite = kind === 'wing' ? c.createWingService({ geometry, parameters: parameter }) : c.createFuselageService(geometry, parameter)
      c.pending = composite.get(id, identity).then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', code: error.code }))
      return { id, identity }
    }, kind)
    await page.waitForFunction(() => window.__case.trace.includes('xsec:waiting'), { timeout: 30000 })
    assert.deepEqual(await page.evaluate(() => window.__case.trace), kind === 'wing'
      ? ['geometry:start', 'geometry:done', 'xsec:waiting']
      : ['geometry:start', 'geometry:done', 'length:start', 'length:done', 'xsec:waiting'])
    // Exercise real mirrored GUI New, including its destructive confirmation.
    await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
    await page.locator('.menu-list').getByRole('button', { name: 'New', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click()
    await page.waitForFunction(epoch => window.__webvspEngine.testCall('model').then(m => m.modelEpochValid && m.modelEpoch !== epoch), setup.identity.modelEpoch, { timeout: 30000 })
    const after = await page.evaluate(async ({ kind, old }) => {
      const c = window.__case
      const current = (await c.service.model.getInfo()).identity
      const replacementId = (await window.__webvspEngine.request('POST', '/geoms', { type: kind.toUpperCase() })).id
      // First demonstrate that the replacement itself supports the same composite read.
      const fresh = await c.service[kind].get(replacementId, current)
      c.release()
      const outcome = await c.pending
      return { current, replacementId, fresh, outcome, trace: c.trace }
    }, { kind, old: setup.identity })
    assert.equal(after.current.sessionId, setup.identity.sessionId)
    assert.notEqual(after.current.modelEpoch, setup.identity.modelEpoch)
    assert.notEqual(after.replacementId, setup.id)
    assert.deepEqual(after.outcome, { status: 'rejected', code: 'STALE_MODEL' })
    assert.deepEqual(after.trace.slice(-2), ['xsec:dispatch', 'xsec:error:STALE_MODEL'])
    assert.ok(after.fresh.surfaces.length)
    if (kind === 'wing') {
      assert.equal(after.fresh.geometryId, after.replacementId)
      assert.ok(after.fresh.surfaces[0].stations.length)
    } else {
      assert.equal(after.fresh.geometry.id, after.replacementId)
      assert.ok(after.fresh.surfaces[0].sections.length)
    }
    console.log(`PASS ${kind}: ${after.trace.join(' -> ')}; epoch ${setup.identity.modelEpoch} -> ${after.current.modelEpoch}; fresh composite recovered`)
  }
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__case.service.close())
} finally { await browser.close() }
