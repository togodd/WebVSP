// Disposable end-to-end experiment: production WASM + DEV-only guarded test hook.
// The independent write service is NOT the public facade; this does not establish
// write safety, concurrency safety, or real filesystem picker behavior. Never retry
// an unknown write outcome. Use only a fresh browser context, without user actions.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/guarded-write-persistence-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: experiment timed out; do not retry unknown writes'); process.exit(1) }, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    let bytes = null
    window.__experimentPicker = { saves: 0, opens: 0, size: 0 }
    const handle = {
      name: 'isolated-write-experiment.vsp3',
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      getFile: async () => { if (!bytes) throw Error('No saved bytes'); return new File([bytes], 'isolated-write-experiment.vsp3') },
      createWritable: async () => ({
        write: async data => { bytes = new Uint8Array(data) },
        close: async () => { window.__experimentPicker.saves++; window.__experimentPicker.size = bytes.length },
      }),
    }
    window.showSaveFilePicker = async () => handle
    window.showOpenFilePicker = async () => { window.__experimentPicker.opens++; return [handle] }
  })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const result = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine?.testCallGuarded !== 'function') throw Error('DEV-only guarded hook unavailable')
    const { createWriteService } = await import('/src/modeling/writeService.ts')
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const facade = createBrowserModelingService()
    try {
      const initial = await facade.model.getInfo()
      if (initial.geometries.length !== 0) throw Error('Expected isolated empty model')
      const identity = initial.identity
      const check = token => {
        if (!token || token.sessionId !== identity.sessionId || token.modelEpoch !== identity.modelEpoch || token === identity) throw Error('Invalid identity forwarding')
      }
      const call = (op, a = '', b = '', value = 0) => engine.testCallGuarded(op, a, b, value, identity.modelEpoch)
      const writes = []
      const adapter = {
        model: token => { check(token); return call('model') },
        // geomTypes is not in the guarded bridge allowlist; it is a real,
        // unguarded capability read, not an epoch-atomic read.
        geomTypes: token => { check(token); return engine.testCall('geomTypes', '', '', 0) },
        addGeom: async (type, parent, token) => { check(token); writes.push(['create', type, parent]); return call('addGeom', type, parent ?? '') },
        geomOrigin: (id, token) => { check(token); return call('origin', id) },
        moveGeoms: async (ids, delta, token) => { check(token); writes.push(['move', ids, delta]); return call('move', ids.join(','), delta.join(',')) },
      }
      const service = createWriteService(adapter)
      // Exactly one attempt for each operation; on any error the experiment stops.
      const root = (await service.create({ type: 'FUSELAGE', parentId: null }, identity)).geometryId
      const child = (await service.create({ type: 'WING', parentId: root }, identity)).geometryId
      const before = await call('origin', child)
      const moved = await service.move({ geometryId: child, frame: 'world', units: 'model-native', delta: [1, 2, 3] }, identity)
      const model = await call('model')
      const origin = await call('origin', child)
      let facadeWrite
      try { await facade.write.move({ geometryId: child, frame: 'world', units: 'model-native', delta: [1, 0, 0] }, identity); facadeWrite = 'SUCCEEDED' }
      catch (error) { facadeWrite = error.code }
      return { identity, root, child, before, moved, model, origin, writes, facadeWrite }
    } finally { facade.close() }
  })
  assert.equal(result.model.geoms.length, 2)
  const root = result.model.geoms.find(g => g.id === result.root)
  const child = result.model.geoms.find(g => g.id === result.child)
  assert.equal(root.type.toUpperCase(), 'FUSELAGE'); assert.equal(root.parent, null)
  assert.equal(child.type.toUpperCase(), 'WING'); assert.equal(child.parent, result.root)
  assert.deepEqual(result.origin, result.before.map((v, i) => v + [1, 2, 3][i]))
  assert.deepEqual(result.moved, { geometryId: result.child, origin: result.origin })
  assert.deepEqual(result.writes, [['create', 'FUSELAGE', null], ['create', 'WING', result.root], ['move', [result.child], [1, 2, 3]]])
  assert.equal(result.facadeWrite, 'UNSUPPORTED_OPERATION')
  const guiTree = async () => {
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.m-tree .m-titem')]
      return rows.some(e => e.textContent.includes('Fuselage')) && rows.some(e => e.textContent.includes('Wing'))
    }, null, { timeout: 30000 })
    return page.locator('.m-tree .m-titem').evaluateAll(rows => rows.map(e => ({ text: e.textContent, left: parseFloat(e.style.left), top: parseFloat(e.style.top) })))
  }
  const checkGui = rows => {
    const f = rows.find(r => r.text.includes('Fuselage')), w = rows.find(r => r.text.includes('Wing'))
    assert.ok(f && w, JSON.stringify(rows)); assert.ok(w.top > f.top); assert.ok(w.left > f.left, JSON.stringify(rows))
  }
  checkGui(await guiTree())
  const menu = async name => {
    await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
    await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
  }
  await menu('Save As...')
  await page.waitForFunction(() => window.__experimentPicker.saves > 0 && window.__experimentPicker.size > 0, null, { timeout: 30000 })
  await page.evaluate(() => window.__webvspEngine.request('POST', '/file/new'))
  assert.equal((await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))).geoms.length, 0)
  await menu('Open...')
  await page.waitForFunction(() => window.__experimentPicker.opens > 0, null, { timeout: 30000 })
  await page.waitForFunction(() => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === 2), null, { timeout: 30000 })
  const reopened = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    const model = await engine.request('GET', '/model')
    const f = model.geoms.find(g => g.type.toUpperCase() === 'FUSELAGE')
    const w = model.geoms.find(g => g.type.toUpperCase() === 'WING')
    if (!f || !w) throw Error('Reopened types not found')
    return { model, root: f.id, child: w.id, origin: await engine.request('GET', `/geoms/${w.id}/origin`) }
  })
  assert.equal(reopened.model.geoms.length, 2)
  assert.equal(reopened.model.geoms.find(g => g.id === reopened.root).parent, null)
  assert.equal(reopened.model.geoms.find(g => g.id === reopened.child).parent, reopened.root)
  assert.deepEqual(reopened.origin, result.origin)
  checkGui(await guiTree())
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ created: { root: result.root, child: result.child, origin: result.origin }, reopened: { root: reopened.root, child: reopened.child, origin: reopened.origin }, writes: result.writes, facadeWrite: result.facadeWrite }, null, 2))
  console.log('PASS: isolated independent service + guarded adapter create/move, mirrored hierarchy and fake-picker persistence; write safety is NOT proven')
  await context.close()
} finally { if (browser) await browser.close(); clearTimeout(deadline) }
