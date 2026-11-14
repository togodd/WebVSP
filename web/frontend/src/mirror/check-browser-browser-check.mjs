// Isolated real-WASM check-browser regression. Vite is started and stopped by this script.
// WEBVSP_TEST_WASM_ORIGIN=http://127.0.0.1:5217 WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/mirror/check-browser-browser-check.mjs
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(base)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const tree = page.locator('.m-w.m-tree').first()
  const geom = tree.locator('.m-titem').filter({ hasText: 'PodGeom' }).first()
  await geom.waitFor({ timeout: 30000 })
  await geom.locator('.m-tlabel').click()
  const list = page.locator('.m-w.m-check_browser').filter({ hasText: 'Not_Shown' }).first()
  await list.waitFor({ timeout: 30000 })
  const line = name => list.locator('.m-bline').filter({ hasText: name }).first()
  const checked = name => line(name).locator('.m-checkbox.on').count()
  const waitChecked = async (name, expected) => {
    await page.waitForFunction(({ id, name, expected }) => {
      const list = document.querySelector(`[data-id="${id}"]`)
      const row = [...(list?.querySelectorAll('.m-bline') ?? [])].find(e => e.textContent.trim() === name)
      return !!row && !!row.querySelector('.m-checkbox.on') === expected
    }, { id: await list.getAttribute('data-id'), name, expected }, { timeout: 15000 })
  }
  assert.equal(await checked('Set_0'), 0)
  await line('Set_0').locator('.m-checkbox').click()
  await waitChecked('Set_0', true)
  await line('Set_1').locator('.m-bcell').click()
  await waitChecked('Set_1', true)
  assert.equal(await checked('Set_0'), 1, 'changing Set_1 must not modify Set_0')
  await line('Set_0').locator('.m-bcell').click()
  await waitChecked('Set_0', false)
  assert.equal(await checked('Set_1'), 1)
  console.log('PASS: checkbox and label toggle their own set independently')
  await line('Shown').locator('.m-checkbox').click()
  await waitChecked('Shown', false)
  await waitChecked('Not_Shown', true)
  await page.waitForFunction(async () => !(await window.__webvspEngine.request('GET', '/model')).geoms[0].shown, null, { timeout: 15000 })
  await line('Not_Shown').locator('.m-bcell').click()
  await waitChecked('Not_Shown', false)
  await waitChecked('Shown', true)
  await page.waitForFunction(async () => (await window.__webvspEngine.request('GET', '/model')).geoms[0].shown, null, { timeout: 15000 })
  console.log('PASS: Shown and Not_Shown update model visibility and remain mutually exclusive')
  assert.deepEqual(errors, [])
} finally {
  if (browser) await browser.close()
  vite.kill('SIGTERM')
  await new Promise(resolve => vite.exitCode !== null || vite.signalCode !== null ? resolve() : vite.once('exit', resolve))
}
