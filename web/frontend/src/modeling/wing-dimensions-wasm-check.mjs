// Real Chromium + WASM check. Use only a trusted, disposable loopback Vite
// server with this source tree and a separately built matching engine; this test
// creates a wing in its fresh browser session. Verify engine provenance yourself:
// a passing test does not establish that a supplied WASM matches this source.
// WEBVSP_TEST_PAGE=http://127.0.0.1:5178/ WEBVSP_TEST_CHROMIUM=/path/to/chrome \
//   node src/modeling/wing-dimensions-wasm-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const url = new URL(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Expected disposable loopback server root')
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const result = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const service = createBrowserModelingService()
    if ((await service.model.getInfo()).geometries.length) throw new Error('Expected a fresh model')
    const geom = (await window.__webvspEngine.request('POST', '/geoms', { type: 'WING' })).id
    const identity = (await service.model.getInfo()).identity
    const wing = await service.wing.get(geom, identity)
    const section = wing.surfaces[0].stations[1].id
    const ids = await service.parameter.listCrossSectionParameterIds(section, identity)
    const metadata = []
    for (const id of ids) {
      const p = await service.parameter.getCrossSectionParameter(section, id, identity)
      if (['Span', 'Root_Chord', 'Tip_Chord'].includes(p.name)) metadata.push(p)
    }
    const dimensions = await service.wing.getSectionDimensions(geom, section, identity)
    const publicDimensions = await window.__webvspModelingReadV1.wing.getSectionDimensions(geom, section, identity)
    service.close()
    return { section, metadata, dimensions, publicDimensions }
  })
  // The checked-in WingGeom constructor defines this default single section as
  // span 9, root chord 4, tip chord 1. This additionally detects a mismatch
  // between the supplied engine and that documented fixture.
  assert.deepEqual(result.dimensions, { span: 9, rootChord: 4, tipChord: 1 })
  assert.deepEqual(result.publicDimensions, result.dimensions)
  for (const [field, name] of [['span', 'Span'], ['rootChord', 'Root_Chord'], ['tipChord', 'Tip_Chord']]) {
    const matches = result.metadata.filter(p => p.name === name && p.container === result.section && p.group === 'XSec' && p.type === 0)
    assert.equal(matches.length, 1, `expected exactly one owned double ${name}`)
    assert.equal(result.dimensions[field], matches[0].value)
    assert.ok(Number.isFinite(matches[0].value))
  }
  assert.deepEqual(errors, [])
  console.log('PASS: real wing dimensions agree with uniquely owned native XSec parameters', result.dimensions)
} finally { await browser.close() }
