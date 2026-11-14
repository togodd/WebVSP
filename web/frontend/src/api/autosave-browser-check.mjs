// Isolated real-WASM regression: a reload reopens with the autosaved model and no dialog. Starts
// and stops its own Vite server; requires a matching WASM at WEBVSP_TEST_WASM_ORIGIN.
// WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/api/autosave-browser-check.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const probe = createServer()
await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const base = `http://127.0.0.1:${port}`
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.modeling-test.config.ts', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(), env: { ...process.env, WEBVSP_TEST_WASM_ORIGIN: process.env.WEBVSP_TEST_WASM_ORIGIN ?? 'http://127.0.0.1:8090' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
vite.stdout.on('data', data => { output += data })
vite.stderr.on('data', data => { output += data })
let browser
try {
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${output}`)
    try { if ((await fetch(base)).ok) break } catch {}
    if (i === 99) throw new Error(`Vite did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  const open = async () => {
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(base)
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    return page
  }
  const names = page => page.evaluate(async () => (await window.__webvspEngine.request('GET', '/model')).geoms.map(g => g.name))
  const record = page => page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('webvsp-autosave', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('model')
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const get = db.transaction('model').objectStore('model').get('current')
      get.onsuccess = () => { db.close(); resolve(get.result ? { name: get.result.name, size: get.result.bytes.length } : null) }
      get.onerror = () => reject(get.error)
    }
  }))

  // 1. Build a model and wait for the autosave copy.
  const page1 = await open()
  await page1.evaluate(async () => {
    const e = window.__webvspEngine
    const m = await e.testCall('model', '', '', 0)
    if (m.geoms.length) throw Error('Expected a fresh isolated session')
    const f = await e.testCallGuarded('addGeom', 'FUSELAGE', '', 0, m.modelEpoch)
    await e.testCallGuarded('addGeom', 'WING', f.id, 0, m.modelEpoch)
  })
  await page1.getByRole('button', { name: 'Add', exact: true }).click()
  await page1.waitForFunction(async () => (await window.__webvspEngine.request('GET', '/model')).geoms.length >= 2)
  const saved = (await names(page1)).sort()
  let copy = null
  for (let i = 0; i < 40 && !copy; i++) {
    await page1.waitForTimeout(500)
    copy = await record(page1)
  }
  assert.ok(copy && copy.size > 0, 'autosave copy must exist after changes')
  // Writing the copy must not rename the model: a never-saved model still has no file name.
  assert.equal((await page1.evaluate(() => window.__webvspEngine.request('GET', '/model'))).fileName, '', 'autosave renamed the model')
  console.log('PASS: autosave wrote a copy of', saved.join(', '))
  await page1.close()

  // 2. Reload: the model comes straight back, with no dialog.
  const page2 = await open()
  await page2.waitForFunction(async () => (await window.__webvspEngine.request('GET', '/model')).geoms.length >= 2, null, { timeout: 20000 })
  assert.deepEqual((await names(page2)).sort(), saved, 'reload must restore the same geoms')
  assert.equal(await page2.getByText('An unsaved model from your last session', { exact: false }).count(), 0, 'no restore dialog')
  assert.equal(await page2.getByRole('button', { name: 'Restore', exact: true }).count(), 0, 'no Restore button')
  // The restored model is on screen, not only in the engine.
  for (const name of saved) await page2.locator('.m-w.m-tree .m-titem').filter({ hasText: name }).first().waitFor({ timeout: 20000 })
  assert.equal((await page2.evaluate(() => window.__webvspEngine.request('GET', '/model'))).dirty, true, 'restored model is unsaved')
  console.log('PASS: reload restored', saved.join(', '), 'in the tree and the engine, no dialog')
  await page2.close()

  // 3. A second reload does the same, and an empty model clears the copy.
  const page3 = await open()
  await page3.waitForFunction(async () => (await window.__webvspEngine.request('GET', '/model')).geoms.length >= 2, null, { timeout: 20000 })
  assert.deepEqual((await names(page3)).sort(), saved)
  await page3.evaluate(() => window.__webvspEngine.request('POST', '/file/new'))
  await page3.waitForFunction(async () => (await window.__webvspEngine.request('GET', '/model')).geoms.length === 0, null, { timeout: 20000 })
  let cleared = await record(page3)
  for (let i = 0; i < 20 && cleared !== null; i++) {
    await page3.waitForTimeout(500)
    cleared = await record(page3)
  }
  assert.equal(cleared, null, 'an empty model clears the copy')
  await page3.close()
  const page4 = await open()
  await page4.waitForTimeout(4000)
  assert.deepEqual(await names(page4), [], 'an empty model stays empty after reload')
  await page4.close()
  console.log('PASS: empty model clears the copy and stays empty')
  assert.deepEqual(errors, [])
} finally {
  if (browser) await browser.close()
  vite.kill('SIGTERM')
  await new Promise(resolve => vite.exitCode !== null || vite.signalCode !== null ? resolve() : vite.once('exit', resolve))
}
