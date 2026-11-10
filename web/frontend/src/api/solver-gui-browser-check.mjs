// Real GUI -> engine -> VSPAERO workers, with a fresh in-memory model.
// WEBVSP_TEST_PAGE must be an isolated server with compatible WASM (default :5179).
// This never opens, saves, or writes a user's files.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM to a Chromium executable')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.__solverWorkers = []
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        if (!String(url).includes('program.worker.js')) return
        const record = { cmd: '', args: [], exits: [], output: '' }
        window.__solverWorkers.push(record)
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'out') record.output += data.text
          if (data.type === 'exit') record.exits.push({ code: data.code, files: data.files.map(f => ({ path: f.path, size: f.data.byteLength })) })
        })
        const post = this.postMessage.bind(this)
        this.postMessage = (message, transfer) => {
          record.cmd = message.cmd; record.args = message.args
          return post(message, transfer)
        }
      }
    }
  })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const select = page.locator('select').filter({ has: page.locator('option:text-is("WING")') }).first()
  await select.selectOption({ label: 'WING' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.getByText('WingGeom', { exact: true }).first().waitFor()
  await page.locator('.m-menubar').getByRole('button', { name: 'Analysis', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'Aero', exact: false }).hover()
  await page.getByRole('button', { name: 'VSPAERO...', exact: true }).click()
  await page.getByRole('button', { name: 'Launch Solver', exact: true }).click()
  await page.waitForFunction(() => window.__solverWorkers.some(w => w.cmd === 'vspaero' && w.exits.length), null, { timeout: 120000 })
  await page.getByText('Results Manager - VSPAERO', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.getByText('MeshGeom_NGon', { exact: true }).first().waitFor({ timeout: 30000 })
  const workers = await page.evaluate(() => window.__solverWorkers)
  for (const w of workers) console.log(JSON.stringify({ cmd: w.cmd, args: w.args, exits: w.exits, outputTail: w.output.slice(-1200) }))
  const solver = workers.find(w => w.cmd === 'vspaero')
  assert.ok(solver, 'real solver worker must launch')
  assert.equal(solver.exits.length, 1)
  assert.equal(solver.exits[0].code, 0)
  assert.ok(solver.exits[0].files.some(f => f.path.endsWith('.adb') && f.size > 0), 'solver must produce nonempty ADB')
  assert.deepEqual(errors, [])
  console.log('PASS: real GUI wing -> VSPAERO worker -> ADB and Results Manager')
  await context.close()
} finally {
  await browser.close()
}
