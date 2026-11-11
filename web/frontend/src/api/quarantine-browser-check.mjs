// Real Chromium regression against the DEV page; only fake handles/FS are touched.
// From web/frontend: WEBVSP_TEST_PAGE=http://127.0.0.1:5179/ WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/api/quarantine-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM ?? '/home/togo/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const url = process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/'
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  for (const locale of ['en-US', 'zh-CN']) {
    // Quarantine is page-lifetime state, so never share a context between cases.
    const context = await browser.newContext({ locale, serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      await page.goto(url)
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      await page.evaluate(() => {
        const api = window.__webvspEngine?.testFiles
        if (!api) throw Error('DEV testFiles unavailable')
        api.clear()
        const home = '/home/web_user/', data = new Map(), answers = [], writes = [], reads = [], deliveries = []
        let picked = [], saveName = '', fail = true, nested
        const handle = name => ({ name, getFile: async () => new File(['content-' + name], name),
          queryPermission: async () => 'granted', createWritable: async () => ({
            write: async bytes => deliveries.push({ name, bytes: Array.from(bytes) }), close: async () => {},
          }) })
        const fs = {
          mkdirTree() {}, analyzePath: p => ({ exists: data.has(p) }),
          stat: p => ({ mtime: new Date(data.get(p).time), size: data.get(p).bytes.length }),
          readFile: p => { reads.push(p); return data.get(p).bytes },
          writeFile: (p, bytes) => {
            writes.push(p); data.set(p, { bytes: new Uint8Array(bytes), time: 1 })
            if (fail && p.endsWith('b.dat')) {
              fail = false
              // The import reservation rejects a reentrant save before any binding can be created.
              window.showSaveFilePicker = undefined
              nested = api.answer(vsp, { seq: 90, mode: 1, filter: '*.dat', preset: 'b.dat' })
              throw Error('injected failure after second write')
            }
          },
        }
        const vsp = { FS: fs, mirrorEvent: json => answers.push(JSON.parse(json)) }
        window.showOpenFilePicker = async () => picked.map(handle)
        window.__quarantineCheck = {
          api, data, answers, writes, reads, deliveries, home,
          open: async (seq, names) => { picked = names; await api.answer(vsp, { seq, mode: 0, filter: '*.vsp3' }); if (nested) await nested },
          save: async (seq, name) => { saveName = name; window.showSaveFilePicker = async () => handle(saveName); await api.answer(vsp, { seq, mode: 1, filter: '*.vsp3' }) },
          watch: () => api.watch(vsp),
          change: name => { const item = data.get(home + name); item.time++; item.bytes = new Uint8Array([42, 43]) },
        }
      })
      await page.evaluate(() => window.__quarantineCheck.open(1, ['a.vsp3', 'b.dat', 'c.dat']))
      const severe = page.getByRole('alert').filter({ hasText: locale.startsWith('zh') ? '导入可能只完成了一部分' : 'Import may have only partially completed' })
      await severe.waitFor()
      assert.equal(await severe.count(), 1)
      const initial = await page.evaluate(() => {
        const t = window.__quarantineCheck
        return { answers: t.answers, writes: t.writes, bindingA: !!t.api.state(t.home + 'a.vsp3'), bindingB: !!t.api.state(t.home + 'b.dat'), cExists: t.data.has(t.home + 'c.dat') }
      })
      assert.deepEqual(initial.answers, [
        { op: 'dialog', seq: 90, result: 0, path: '' },
        { op: 'dialog', seq: 1, result: 0, path: '' },
      ])
      assert.deepEqual(initial.writes, ['/home/web_user/a.vsp3', '/home/web_user/b.dat'])
      assert.equal(initial.bindingA, false); assert.equal(initial.bindingB, false); assert.equal(initial.cExists, false)
      await page.evaluate(() => { const t = window.__quarantineCheck; t.change('b.dat'); t.watch(); t.watch() })
      assert.deepEqual(await page.evaluate(() => ({ reads: window.__quarantineCheck.reads, deliveries: window.__quarantineCheck.deliveries })), { reads: [], deliveries: [] })
      // Every staged target is rejected, including the never-written third target.
      for (const [i, name] of ['a.vsp3', 'b.dat', 'c.dat'].entries()) {
        await page.evaluate(({ i, name }) => window.__quarantineCheck.open(10 + i, [name]), { i, name })
        const status = page.getByRole('status')
        await status.getByText(locale.startsWith('zh') ? /打开已取消：此页面已隔离该路径/ : /Open was cancelled: this path is quarantined/).waitFor()
        await status.getByText(name, { exact: true }).waitFor()
        await page.evaluate(({ i, name }) => window.__quarantineCheck.save(20 + i, name), { i, name })
        await status.getByText(locale.startsWith('zh') ? /另存为已取消：此页面已隔离该路径/ : /Save As was cancelled: this path is quarantined/).waitFor()
        await status.getByText(name, { exact: true }).waitFor()
      }
      assert.equal(await severe.count(), 1, 'ordinary notices must not create severe warnings')
      await page.evaluate(async () => { const t = window.__quarantineCheck; await t.open(30, ['a-other.vsp3']); t.change('a-other.vsp3'); t.watch(); t.watch(); await t.save(31, 'save-other.vsp3') })
      await page.waitForFunction(() => window.__quarantineCheck.deliveries.length === 1)
      const result = await page.evaluate(() => {
        const t = window.__quarantineCheck
        return { answers: t.answers, writes: t.writes, reads: t.reads, deliveries: t.deliveries }
      })
      for (const seq of [10, 11, 12, 20, 21, 22]) assert.deepEqual(result.answers.find(a => a.seq === seq), { op: 'dialog', seq, result: 0, path: '' })
      for (const [seq, path] of [[30, '/home/web_user/a-other.vsp3'], [31, '/home/web_user/save-other.vsp3']]) assert.deepEqual(result.answers.find(a => a.seq === seq), { op: 'dialog', seq, result: 1, path })
      assert.deepEqual(result.writes, ['/home/web_user/a.vsp3', '/home/web_user/b.dat', '/home/web_user/a-other.vsp3'])
      assert.deepEqual(result.reads, ['/home/web_user/a-other.vsp3'])
      assert.deepEqual(result.deliveries, [{ name: 'a-other.vsp3', bytes: [42, 43] }])
      assert.equal(await severe.count(), 1, 'severe warning persists through later operations')
      console.log(`PASS ${locale}: multi-file partial commit, exact-path quarantine, watcher and notifications`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
