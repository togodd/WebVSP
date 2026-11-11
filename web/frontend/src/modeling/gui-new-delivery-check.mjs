// Real browser, isolated contexts, fake in-memory file handles and intercepted downloads.
// Run from web/frontend against the dev server and rebuilt WASM:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/gui-new-delivery-check.mjs
// This tests delivery and reopening of captured bytes, NOT real disk persistence or permissions.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  for (const mode of ['success', 'createWritable', 'write', 'close']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      await page.addInitScript(mode => {
        const state = window.__delivery = { saves: 0, opens: 0, creates: 0, writes: 0, closes: 0, downloads: [], bytes: null }
        let pending = null
        const blobs = new Map()
        const createObjectURL = URL.createObjectURL.bind(URL)
        URL.createObjectURL = blob => {
          const url = createObjectURL(blob)
          blobs.set(url, blob)
          return url
        }
        const click = HTMLAnchorElement.prototype.click
        HTMLAnchorElement.prototype.click = function () {
          if (this.download && blobs.has(this.href)) {
            state.downloads.push({ name: this.download, blob: blobs.get(this.href) })
            return // Do not create any host download file.
          }
          return click.call(this)
        }
        const handle = {
          name: 'new-delivery-test.vsp3',
          queryPermission: async () => 'granted', requestPermission: async () => 'granted',
          getFile: async () => {
            const content = mode === 'success' ? state.bytes : state.downloads[0]?.blob
            if (!content) throw new Error('No delivered bytes to reopen')
            return new File([content], 'new-delivery-test.vsp3')
          },
          createWritable: async () => {
            state.creates++
            if (mode === 'createWritable') throw new Error('injected createWritable failure')
            return {
              write: async bytes => {
                state.writes++
                if (mode === 'write') throw new Error('injected write failure')
                pending = new Uint8Array(bytes).slice()
              },
              close: async () => {
                state.closes++
                if (mode === 'close') throw new Error('injected close failure')
                state.bytes = pending
              },
            }
          },
        }
        window.showSaveFilePicker = async () => { state.saves++; return handle }
        window.showOpenFilePicker = async () => { state.opens++; return [handle] }
      }, mode)
      await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      assert.equal(await page.evaluate(() => crossOriginIsolated), true)
      const req = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
      const model = () => req('GET', '/model')
      const menu = async name => {
        await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
        await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
      }
      async function parameter(geom, name, group) {
        for (const id of await req('GET', `/geoms/${geom}/parms`)) {
          const p = await req('GET', `/geoms/${geom}/parms/${id}`)
          if (p.name === name && p.group === group) return p
        }
        throw new Error(`Missing parameter ${group}/${name}`)
      }
      const fuse = (await req('POST', '/geoms', { type: 'FUSELAGE' })).id
      await req('POST', '/geoms', { type: 'WING', parent: fuse })
      const length = await parameter(fuse, 'Length', 'Design')
      await req('PUT', `/geoms/${fuse}/parms/${length.id}`, { value: 20 })
      assert.equal((await parameter(fuse, 'Length', 'Design')).value, 20)
      const before = await model()
      assert.equal(before.geoms.length, 2)
      assert.equal(before.modelEpochValid, true)
      await menu('New')
      await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(epoch => window.__webvspEngine.request('GET', '/model').then(m => m.modelEpochValid && m.modelEpoch !== epoch && m.geoms.length === 0), before.modelEpoch, { timeout: 30000 })
      await page.waitForFunction(mode => mode === 'success' ? !!window.__delivery.bytes : window.__delivery.downloads.length > 0, mode, { timeout: 30000 })
      const delivery = await page.evaluate(async () => {
        const d = window.__delivery
        return { saves: d.saves, creates: d.creates, writes: d.writes, closes: d.closes, bytes: d.bytes?.length ?? 0, downloads: await Promise.all(d.downloads.map(async x => ({ name: x.name, size: x.blob.size, text: await x.blob.text() }))) }
      })
      assert.equal(delivery.saves, 1)
      assert.equal(delivery.creates, 1)
      assert.equal(delivery.writes, mode === 'createWritable' ? 0 : 1)
      assert.equal(delivery.closes, ['success', 'close'].includes(mode) ? 1 : 0)
      if (mode === 'success') {
        assert.ok(delivery.bytes > 0)
        assert.equal(delivery.downloads.length, 0)
      } else {
        assert.equal(delivery.bytes, 0)
        assert.equal(delivery.downloads.length, 1)
        assert.equal(delivery.downloads[0].name, 'new-delivery-test.vsp3')
        assert.ok(delivery.downloads[0].size > 0)
        assert.match(delivery.downloads[0].text, /<Vsp_Geometry/)
      }
      await menu('Open...')
      await page.waitForFunction(() => window.__delivery.opens === 1, null, { timeout: 30000 })
      await page.waitForFunction(() => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === 2), null, { timeout: 30000 })
      const reopened = await model()
      const f = reopened.geoms.find(g => g.type === 'Fuselage')
      const w = reopened.geoms.find(g => g.type === 'Wing')
      assert.ok(f && w, 'captured content must restore both original geometries')
      assert.equal(w.parent, f.id)
      assert.equal((await parameter(f.id, 'Length', 'Design')).value, 20)
      assert.deepEqual(errors, [])
      console.log(`PASS: New Save ${mode}: ${mode === 'success' ? 'write + close' : 'fallback download blob'} reopened original geometry`)
    } finally { await context.close() }
  }
  console.log('Fake handles and intercepted blobs do not prove real filesystem persistence or native picker permissions.')
} finally { await browser.close() }
