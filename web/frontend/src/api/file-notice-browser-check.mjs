// Run against a disposable Vite dev page: WEBVSP_TEST_PAGE=... WEBVSP_TEST_CHROMIUM=... node src/api/file-notice-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

if (!process.env.WEBVSP_TEST_PAGE || !process.env.WEBVSP_TEST_CHROMIUM) throw Error('Set WEBVSP_TEST_PAGE and WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath: process.env.WEBVSP_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] })
try {
  for (const locale of ['en-US', 'zh-CN']) {
    const context = await browser.newContext({ locale, serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      await page.goto(process.env.WEBVSP_TEST_PAGE)
      await page.waitForSelector('[role=status]', { state: 'attached' })
      const result = await page.evaluate(async () => {
        const test = window.__webvspEngine.testFiles
        test.clear()
        const answers = []
        const fs = new Map()
        const vsp = { mirrorEvent: json => answers.push(JSON.parse(json)), FS: {
          mkdirTree() {}, writeFile: (p, data) => fs.set(p, data), analyzePath: p => ({ exists: fs.has(p) }),
          stat: p => ({ mtime: new Date(0), size: fs.get(p).length }),
        } }
        window.showOpenFilePicker = async () => [{ name: 'a.vsp3', getFile: async () => new File(['old'], 'a.vsp3') }]
        await test.answer(vsp, { seq: 1, kind: 'file', mode: 0, filter: '*.vsp3' })
        test.state('/home/web_user/a.vsp3').pending = true
        const input = document.createElement('input'); document.body.append(input); input.focus()
        await test.answer(vsp, { seq: 2, kind: 'file', mode: 0, filter: '*.vsp3' })
        return { answers, contents: new TextDecoder().decode(fs.get('/home/web_user/a.vsp3')), focused: document.activeElement === input }
      })
      assert.equal(result.answers.length, 2)
      assert.equal(result.answers[1].result, 0)
      assert.equal(result.contents, 'old')
      assert.equal(result.focused, true)
      await page.getByRole('status').getByText(locale.startsWith('zh') ? /已拒绝/ : /was rejected/).waitFor()
    } finally { await context.close() }
  }
  console.log('File notification browser checks passed')
} finally { await browser.close() }
