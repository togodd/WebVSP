// Real GUI New -> Save with a deliberately suspended, then rejected fake handle.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/gui-new-delivery-rejection-browser-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/ (isolated server with compatible WASM).
// No native picker or host file is used: download clicks are intercepted in memory.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  for (const failure of ['write', 'close']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('crash', () => console.log(`${failure}: page crashed`))
      page.on('close', () => console.log(`${failure}: page closed`))
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log(`${failure}: navigation ${frame.url()}`) })
      page.on('console', message => { if (message.text().includes('[vite]')) console.log(`${failure}: ${message.text()}`) })
      await page.addInitScript(failure => {
        const s = window.__deliveryRejection = { calls: [], downloads: [], attempted: null, persisted: null, release: null }
        const gate = new Promise(resolve => { s.release = resolve })
        const blobs = new Map()
        const nativeCreate = URL.createObjectURL.bind(URL)
        URL.createObjectURL = blob => { const url = nativeCreate(blob); blobs.set(url, blob); return url }
        const nativeClick = HTMLAnchorElement.prototype.click
        HTMLAnchorElement.prototype.click = function () {
          if (this.download && blobs.has(this.href)) { s.downloads.push({ name: this.download, blob: blobs.get(this.href) }); return }
          return nativeClick.call(this)
        }
        const handle = {
          name: 'controlled-new.vsp3',
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          getFile: async () => {
            s.calls.push('open')
            if (!s.downloads[0]) throw new Error('No captured fallback')
            return new File([s.downloads[0].blob], 'controlled-new.vsp3')
          },
          createWritable: async () => {
            s.calls.push('createWritable')
            return {
              write: async bytes => {
                s.calls.push('write'); s.attempted = new Uint8Array(bytes).slice()
                if (failure === 'write') { await gate; throw new Error('controlled write rejection') }
              },
              close: async () => {
                s.calls.push('close')
                if (failure === 'close') { await gate; throw new Error('controlled close rejection') }
                s.persisted = s.attempted
              },
            }
          },
        }
        window.showSaveFilePicker = async () => { s.calls.push('savePicker'); return handle }
        window.showOpenFilePicker = async () => [handle]
      }, failure)
      await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      assert.equal(await page.evaluate(() => crossOriginIsolated), true)
      const req = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
      const model = () => req('GET', '/model')
      const menu = async name => {
        await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
        await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
      }
      const fuse = (await req('POST', '/geoms', { type: 'FUSELAGE' })).id
      await req('POST', '/geoms', { type: 'WING', parent: fuse })
      const before = await model()
      assert.equal(before.geoms.length, 2)
      assert.equal(before.modelEpochValid, true)
      await menu('New')
      await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(failure => window.__deliveryRejection.calls.includes(failure), failure, { timeout: 30000 })
      // Deliberately keep delivery unresolved while observing whether GUI New already renewed.
      await page.waitForFunction(epoch => window.__webvspEngine.request('GET', '/model').then(m => m.modelEpochValid && m.modelEpoch !== epoch && m.geoms.length === 0), before.modelEpoch, { timeout: 30000 })
      const pending = await page.evaluate(() => ({ calls: window.__deliveryRejection.calls.slice(), attempted: window.__deliveryRejection.attempted?.length, persisted: !!window.__deliveryRejection.persisted, downloads: window.__deliveryRejection.downloads.length }))
      assert.deepEqual(pending.calls, failure === 'write' ? ['savePicker', 'createWritable', 'write'] : ['savePicker', 'createWritable', 'write', 'close'])
      assert.ok(pending.attempted > 0)
      assert.equal(pending.persisted, false)
      assert.equal(pending.downloads, 0)
      await page.evaluate(() => window.__deliveryRejection.release())
      await page.waitForFunction(() => window.__deliveryRejection.downloads.length === 1, null, { timeout: 30000 })
      const fallback = await page.evaluate(async () => {
        const d = window.__deliveryRejection.downloads[0]
        const bytes = new Uint8Array(await d.blob.arrayBuffer())
        const attempted = window.__deliveryRejection.attempted
        return { name: d.name, size: d.blob.size, text: await d.blob.text(), sameBytes: bytes.length === attempted.length && bytes.every((v, i) => v === attempted[i]), attempted: attempted.length, persisted: !!window.__deliveryRejection.persisted }
      })
      assert.equal(fallback.name, 'controlled-new.vsp3')
      assert.equal(fallback.size, fallback.attempted)
      assert.equal(fallback.sameBytes, true)
      assert.equal(fallback.persisted, false)
      assert.match(fallback.text, /<Vsp_Geometry/)
      await menu('Open...')
      await page.waitForFunction(() => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === 2), null, { timeout: 30000 })
      const reopened = await model()
      const f = reopened.geoms.find(g => g.type === 'Fuselage')
      const w = reopened.geoms.find(g => g.type === 'Wing')
      assert.ok(f && w)
      assert.equal(w.parent, f.id)
      assert.deepEqual(errors, [])
      console.log(`PASS ${failure}: New renewed while ${failure} pending; fake handle not persisted; rejected delivery fell back to ${fallback.size} in-memory bytes; reopened original hierarchy`)
    } finally { await context.close() }
  }
  console.log('Characterization only: intercepted fallback is not proof of a user-accepted download or real disk persistence.')
} finally { await browser.close() }
