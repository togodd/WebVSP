// Real production WASM, DEV-only guarded engine calls, and actual mirrored GUI menus.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/guarded-create-gui-save-open-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/ and must serve the guarded
// hook with cross-origin isolation. The fake handle stores bytes only in page memory;
// this is neither a public facade write test nor real disk/picker persistence.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: guarded GUI save/open timed out; do not retry unknown writes'); process.exit(1) }, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false })
  try {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const state = window.__guardedDelivery = { pickSaves: 0, pickOpens: 0, creates: 0, writes: 0, closes: 0, downloads: 0, bytes: null }
      let pending = null
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { state.downloads++; return } // Never write a host download.
        return click.call(this)
      }
      const handle = {
        name: 'guarded-create-save-open.vsp3',
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        getFile: async () => {
          if (!state.bytes) throw new Error('No closed fake-handle write to reopen')
          return new File([state.bytes], 'guarded-create-save-open.vsp3')
        },
        createWritable: async () => {
          state.creates++
          return {
            write: async data => { state.writes++; pending = new Uint8Array(data).slice() },
            close: async () => { state.closes++; if (!pending) throw new Error('No bytes written'); state.bytes = pending },
          }
        },
      }
      window.showSaveFilePicker = async () => { state.pickSaves++; return handle }
      window.showOpenFilePicker = async () => { state.pickOpens++; return [handle] }
    })
    await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    assert.equal(await page.evaluate(() => crossOriginIsolated), true)
    const created = await page.evaluate(async () => {
      const engine = window.__webvspEngine
      if (typeof engine?.testCallGuarded !== 'function') throw new Error('Missing dev-only guarded hook')
      const initial = await engine.testCall('model', '', '', 0)
      if (!initial.modelEpochValid || initial.geoms.length) throw new Error('Expected isolated empty model')
      const call = (op, a = '', b = '') => engine.testCallGuarded(op, a, b, 0, initial.modelEpoch)
      // Exactly one attempt each: these are the real low-level guarded operations,
      // not facade writes or a mock adapter. Stop on any uncertain outcome.
      const body = await call('addGeom', 'FUSELAGE')
      if (!body.id) throw new Error(`Fuselage creation failed: ${JSON.stringify(body)}`)
      const wing = await call('addGeom', 'WING', body.id)
      if (!wing.id) throw new Error(`Wing creation failed: ${JSON.stringify(wing)}`)
      const before = await call('origin', wing.id)
      const moved = await call('move', wing.id, '1,2,3')
      const after = await call('origin', wing.id)
      return { initial, body, wing, before, moved, after, tree: await call('model'), bodyOrigin: await call('origin', body.id) }
    })
    assert.notEqual(created.body.id, created.wing.id)
    assert.equal(created.moved.ok, true)
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(created.after[i] - created.before[i] - [1, 2, 3][i]) < 1e-7, `move axis ${i}`)
    function checkHierarchy(tree, bodyId, wingId) {
      assert.equal(tree.modelEpochValid, true)
      assert.equal(tree.geoms.length, 2)
      const body = tree.geoms.find(g => g.id === bodyId), wing = tree.geoms.find(g => g.id === wingId)
      assert.ok(body && wing)
      assert.equal(body.type.toUpperCase(), 'FUSELAGE'); assert.equal(body.parent, null)
      assert.deepEqual(body.children, [wingId])
      assert.equal(wing.type.toUpperCase(), 'WING'); assert.equal(wing.parent, bodyId)
      assert.deepEqual(wing.children, [])
    }
    checkHierarchy(created.tree, created.body.id, created.wing.id)
    const req = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
    const fuselageLength = id => page.evaluate(id => window.__webvspEngine.testCall('fuselageLength', id, '', 0), id)
    const beforeParms = { length: (await fuselageLength(created.body.id)).value }
    assert.equal(beforeParms.length, 30)
    async function checkGui() {
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.m-tree .m-titem')]
        return rows.some(e => e.textContent.includes('FuselageGeom')) && rows.some(e => e.textContent.includes('WingGeom'))
      }, null, { timeout: 30000 })
      const rows = await page.locator('.m-tree .m-titem').evaluateAll(es => es.map(e => ({ text: e.textContent, left: parseFloat(e.style.left), top: parseFloat(e.style.top) })))
      const f = rows.find(r => r.text.includes('FuselageGeom')), w = rows.find(r => r.text.includes('WingGeom'))
      assert.ok(f && w && w.top > f.top && w.left > f.left, JSON.stringify(rows))
    }
    await checkGui()
    const menu = async name => {
      await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
      await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
    }
    // New's actual OpenVSP Save confirmation both saves the modified model and
    // replaces it with an empty one. The native picker is a fake in-memory handle.
    await menu('New')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(epoch => window.__webvspEngine.request('GET', '/model').then(m => m.modelEpochValid && m.modelEpoch !== epoch && m.geoms.length === 0), created.tree.modelEpoch, { timeout: 30000 })
    await page.waitForFunction(() => window.__guardedDelivery.bytes?.length > 0, null, { timeout: 30000 })
    const empty = await req('GET', '/model')
    const delivery = await page.evaluate(() => {
      const { pickSaves, creates, writes, closes, downloads, bytes } = window.__guardedDelivery
      return { pickSaves, creates, writes, closes, downloads, size: bytes.length, text: new TextDecoder().decode(bytes) }
    })
    assert.equal(delivery.pickSaves, 1); assert.equal(delivery.creates, 1)
    assert.equal(delivery.writes, 1); assert.equal(delivery.closes, 1); assert.equal(delivery.downloads, 0)
    assert.ok(delivery.size > 0); assert.match(delivery.text, /<Vsp_Geometry/)
    await menu('Open...')
    await page.waitForFunction(() => window.__guardedDelivery.pickOpens === 1, null, { timeout: 30000 })
    await page.waitForFunction(epoch => window.__webvspEngine.request('GET', '/model').then(m => m.modelEpochValid && m.modelEpoch !== epoch && m.geoms.length === 2), empty.modelEpoch, { timeout: 30000 })
    const reopened = await req('GET', '/model')
    const f = reopened.geoms.find(g => g.type.toUpperCase() === 'FUSELAGE')
    const w = reopened.geoms.find(g => g.type.toUpperCase() === 'WING')
    assert.ok(f && w)
    checkHierarchy(reopened, f.id, w.id)
    const reopenedOrigin = await req('GET', `/geoms/${w.id}/origin`)
    const reopenedBodyOrigin = await req('GET', `/geoms/${f.id}/origin`)
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(reopenedOrigin[i] - created.after[i]) < 1e-7, `reopened wing origin axis ${i}`)
      assert.ok(Math.abs(reopenedBodyOrigin[i] - created.bodyOrigin[i]) < 1e-7, `reopened body origin axis ${i}`)
    }
    const afterParms = { length: (await fuselageLength(f.id)).value }
    for (const key of Object.keys(beforeParms)) assert.ok(Math.abs(beforeParms[key] - afterParms[key]) < 1e-7, `reopened parameter ${key}`)
    await checkGui()
    // A successful Open retains its destination: ordinary Save writes the same
    // fake handle without opening another picker.
    await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
    await page.locator('.menu-list').getByRole('button', { name: /^Save\.\.\./ }).click()
    await page.waitForFunction(() => window.__guardedDelivery.closes === 2, null, { timeout: 30000 })
    const afterSave = await page.evaluate(() => ({ ...window.__guardedDelivery, bytes: window.__guardedDelivery.bytes?.length }))
    assert.equal(afterSave.pickSaves, 1)
    assert.equal(afterSave.creates, 2); assert.equal(afterSave.writes, 2); assert.equal(afterSave.closes, 2)
    assert.equal(afterSave.downloads, 0)
    assert.ok(afterSave.bytes > 0)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ created: { body: created.body.id, wing: created.wing.id, before: created.before, after: created.after, parameters: beforeParms }, savedBytes: delivery.size, reopened: { body: f.id, wing: w.id, origin: reopenedOrigin, parameters: afterParms } }, null, 2))
    console.log('PASS: direct guarded create/move -> GUI New/Save -> captured fake-handle bytes -> GUI Open; hierarchy, origins and parameters restored')
    console.log('No facade writes, real host disk persistence, or native picker permissions were tested.')
  } finally { await context.close() }
} finally { if (browser) await browser.close(); clearTimeout(deadline) }
