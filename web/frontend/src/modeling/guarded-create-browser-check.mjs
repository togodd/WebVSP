// Real production WASM through the isolated modeling Vite page (not the public write facade).
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-create-browser-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/; it must serve the dev-only
// guarded hook, cross-origin isolation, and a matching production WASM build.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: guarded create browser check timed out'); process.exit(1) }, 180000)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  // Each page gets its own engine and in-memory model; no host files are opened.
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => window.crossOriginIsolated), true)

  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine?.testCallGuarded !== 'function') throw new Error('Missing dev-only guarded hook')
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const facade = createBrowserModelingService()
    try {
      const initial = await engine.testCall('model', '', '', 0)
      if (!initial.modelEpochValid || initial.geoms.length !== 0) throw new Error('Expected a valid empty isolated model')
      const call = (op, a = '', b = '') => engine.testCallGuarded(op, a, b, 0, initial.modelEpoch)
      // These are direct guarded engine calls, not facade writes or mocked adapters.
      const body = await call('addGeom', 'FUSELAGE')
      if (!body.id) throw new Error(`Root creation failed: ${JSON.stringify(body)}`)
      const wing = await call('addGeom', 'WING', body.id)
      if (!wing.id) throw new Error(`Child creation failed: ${JSON.stringify(wing)}`)
      const tree = await call('model')
      const before = await call('origin', wing.id)
      const moved = await call('move', wing.id, '2,0,0')
      const after = await call('origin', wing.id)
      const model = await facade.model.getInfo()
      const identity = model.identity
      const bodyView = await facade.fuselage.get(body.id, identity)
      const wingView = await facade.wing.get(wing.id, identity)
      // Use the existing model only after capturing the direct-engine observations.
      const created = await facade.write.create({ type: 'WING', parentId: body.id }, identity)
      const facadeMove = await facade.write.move({ geometryId: wing.id, frame: 'world', units: 'model-native', delta: [1, 0, 0] }, identity)
      return { body, wing, tree, before, moved, after, model, bodyView, wingView, created, facadeMove,
        capabilities: facade.capabilities(), finalTree: await call('model'), finalOrigin: await call('origin', wing.id) }
    } finally { facade.close() }
  })
  assert.notEqual(result.body.id, result.wing.id)
  assert.equal(result.tree.geoms.length, 2)
  const body = result.tree.geoms.find(g => g.id === result.body.id)
  const wing = result.tree.geoms.find(g => g.id === result.wing.id)
  assert.ok(body && wing)
  assert.equal(body.parent, null)
  assert.equal(body.type.toUpperCase(), 'FUSELAGE')
  assert.equal(wing.type.toUpperCase(), 'WING')
  assert.deepEqual(body.children, [result.wing.id])
  assert.equal(wing.parent, result.body.id)
  assert.deepEqual(wing.children, [])
  assert.equal(result.model.geometries.length, 2)
  assert.equal(result.model.geometries.find(g => g.id === result.body.id).parentId, null)
  assert.equal(result.model.geometries.find(g => g.id === result.wing.id).parentId, result.body.id)
  assert.equal(result.model.identity.modelEpoch, result.tree.modelEpoch)
  assert.equal(result.moved.ok, true)
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(result.after[i] - result.before[i] - (i === 0 ? 2 : 0)) < 1e-7, `origin axis ${i}`)
  for (const name of ['geometry.create', 'geometry.move']) assert.equal(result.capabilities.features.find(c => c.name === name).status, 'supported')
  assert.notEqual(result.created.geometryId, result.wing.id)
  assert.equal(result.finalTree.geoms.length, 3)
  assert.equal(result.finalTree.geoms.find(g => g.id === result.created.geometryId)?.parent, result.body.id)
  assert.equal(result.finalTree.geoms.find(g => g.id === result.created.geometryId)?.type.toUpperCase(), 'WING')
  assert.deepEqual(result.facadeMove, { geometryId: result.wing.id, origin: result.finalOrigin })
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(result.finalOrigin[i] - result.after[i] - (i === 0 ? 1 : 0)) < 1e-7)
  assert.equal(result.bodyView.length.value, 30)
  assert.equal(result.bodyView.surfaces[0].sections.length, 5)
  assert.equal(result.wingView.surfaces[0].stations[0].kind, 'rootAirfoilStation')
  assert.equal(result.wingView.surfaces[0].stations[1].kind, 'wingSection')
  // Observe the real mirrored OpenVSP Geom Browser, not just the model API.
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.m-tree .m-titem')].map(row => row.textContent)
    return rows.some(s => s.includes('FuselageGeom')) && rows.some(s => s.includes('WingGeom'))
  }, null, { timeout: 30000 })
  const rows = await page.locator('.m-tree .m-titem').allTextContents()
  assert.ok(rows.some(row => row.includes('FuselageGeom')))
  assert.ok(rows.some(row => row.includes('WingGeom')))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ body: result.body, wing: result.wing, tree: result.tree, before: result.before, moved: result.moved, after: result.after, created: result.created, facadeMove: result.facadeMove, guiRows: rows }, null, 2))
  console.log('PASS: guarded addGeom root/child and actual move in production WASM; model and GUI agree; facade writes verified by readback')
} finally { await browser.close(); clearTimeout(deadline) }
