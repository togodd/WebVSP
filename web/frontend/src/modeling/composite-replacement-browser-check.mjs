// Browser integration check: use a dedicated loopback Vite server and production WASM.
// WEBVSP_TEST_PAGE=http://127.0.0.1:<port>/ WEBVSP_TEST_TOKEN=<random hex> WEBVSP_TEST_CHROMIUM=/path/to/chrome \
//   node src/modeling/composite-replacement-browser-check.mjs
// Put the same token in public/__composite_test_token of the disposable Vite root.
// This creates and discards models. Never point it at a user's active browser session.
// Uses an ephemeral browser context and blocks service workers. Routing rejects
// initially cross-origin HTTP requests, but redirects and WebSockets may bypass it;
// this is not a security boundary. The marker is not authentication. Run only
// against a trusted, disposable server and build (Chromium uses --no-sandbox).
// Timeouts are per phase: marker fetch <=10 s, launch <=30 s, browser test
// WEBVSP_TEST_TIMEOUT_MS (default 180 s), with a further 5 s close fallback.
// Forced Node exit is a last resort and does not guarantee child-process cleanup.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
if (!process.env.WEBVSP_TEST_PAGE) throw new Error('Set WEBVSP_TEST_PAGE to a dedicated loopback Vite test server')
const testUrl = new URL(process.env.WEBVSP_TEST_PAGE)
if (testUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(testUrl.hostname) || testUrl.username || testUrl.password || testUrl.pathname !== '/' || testUrl.search || testUrl.hash) throw new Error('Test page must be a loopback HTTP origin root')
const token = process.env.WEBVSP_TEST_TOKEN
if (!token || !/^[0-9a-f]{32,}$/.test(token)) throw new Error('Set WEBVSP_TEST_TOKEN to a random hexadecimal token of at least 32 characters')
const timeoutMs = Number(process.env.WEBVSP_TEST_TIMEOUT_MS ?? 180000)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error('WEBVSP_TEST_TIMEOUT_MS must be 100..600000')
const marker = await fetch(new URL('/__composite_test_token', testUrl), { redirect: 'error', signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)) })
if (!marker.ok || (await marker.text()).trim() !== token) throw new Error('Disposable test server token mismatch')
const browser = await chromium.launch({ executablePath, headless: true, timeout: Math.min(timeoutMs, 30000), args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
let timedOut = false
let forceExit
// Closing the browser terminates in-flight page evaluations instead of merely racing
// their promises. The fallback exits Node if Playwright itself cannot close Chromium.
const deadline = setTimeout(() => {
  timedOut = true
  console.error(`Test deadline exceeded (${timeoutMs} ms); closing browser`)
  forceExit = setTimeout(() => process.exit(1), 5000)
  void browser.close().catch(() => {})
}, timeoutMs)
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false })
  await context.route('**/*', route => new URL(route.request().url()).origin === testUrl.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(testUrl.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.evaluate(async () => {
    const { createBrowserModelingService, createParameterService } = await import('/src/modeling/index.ts')
    const { createWingService } = await import('/src/modeling/wingService.ts')
    const { createFuselageService } = await import('/src/modeling/fuselageService.ts')
    const service = createBrowserModelingService()
    if (!window.__webvspEngine.testCallGuarded) throw new Error('A development frontend with test hooks is required')
    const shapes = createParameterService({
      wingShapes: (id, token) => window.__webvspEngine.testCallGuarded('wingXSecShapes', id, '', 0, token.modelEpoch),
      fuselageShapes: (id, token) => window.__webvspEngine.testCallGuarded('fuselageXSecShapes', id, '', 0, token.modelEpoch),
    })
    window.__case = { service, shapes, createWingService, createFuselageService }
  })
  for (const kind of ['wing', 'fuselage']) {
    // Geometry and length use the production facade. Shape reads use the same
    // parameter service and guarded bridge via the DEV test hook; the gate is JS-only.
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
        [kind === 'wing' ? 'listWingShapes' : 'listFuselageShapes']: async (id, token) => {
          c.trace.push('xsec:waiting')
          await gate
          c.trace.push('xsec:dispatch')
          try {
            const value = await c.shapes[kind === 'wing' ? 'listWingShapes' : 'listFuselageShapes'](id, token)
            c.trace.push('xsec:success')
            return value
          } catch (e) { c.trace.push(`xsec:error:${e.code}`); throw e }
        },
      }
      const composite = kind === 'wing' ? c.createWingService({ geometry, parameters: parameter }) : c.createFuselageService(geometry, parameter)
      c.pending = composite.get(id, identity).then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', code: error.code }))
      return { id, identity }
    }, kind)
    await page.waitForFunction(() => window.__case.trace.includes('xsec:waiting'), null, { timeout: 30000 })
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
} finally {
  try { await browser.close() } finally {
    clearTimeout(deadline)
    clearTimeout(forceExit)
    if (timedOut) process.exitCode = 1
  }
}
