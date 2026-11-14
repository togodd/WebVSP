// Isolated real-WASM regression for renaming a tree item in place. Starts and stops its own Vite
// server; requires a trusted matching WASM at WEBVSP_TEST_WASM_ORIGIN (default 127.0.0.1:8090).
// WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/mirror/tree-rename-browser-check.mjs
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

  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(base)
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    await page.evaluate(async () => {
      const e = window.__webvspEngine
      const m = await e.testCall('model', '', '', 0)
      if (m.geoms.length) throw Error('Expected isolated empty model')
      const f = await e.testCallGuarded('addGeom', 'FUSELAGE', '', 0, m.modelEpoch)
      await e.testCallGuarded('addGeom', 'STACK', '', 0, m.modelEpoch)
    })
    // API creation doesn't wake the screen; Add triggers the normal GUI refresh.
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.locator('.m-w.m-tree').first().locator('.m-titem').filter({ hasText: 'FuselageGeom' }).waitFor({ timeout: 30000 })
    return { page, errors, baseline: await names(page) }
  }
  const tree = page => page.locator('.m-w.m-tree').first()
  const row = (page, name) => tree(page).locator('.m-titem').filter({ hasText: name }).first()
  const rowTop = async (page, name) => (await row(page, name).boundingBox()).y
  // The rename popup is the tree's own edit box (other inputs belong to the browser's fields).
  const popup = page => page.locator('input.m-tree-edit')
  const names = page => page.evaluate(async () => (await window.__webvspEngine.request('GET', '/model')).geoms.map(g => g.name))
  const rect = async (locator) => {
    const b = await locator.boundingBox()
    assert(b, 'element must be visible')
    return b
  }

  // 1. The box opens on the row it edits (not on the first row), with focus, and matches its font.
  {
    const { page, errors, baseline } = await open()
    for (const target of ['FuselageGeom', 'StackGeom']) {
      await row(page, target).locator('.m-tlabel').dblclick()
      await popup(page).waitFor({ timeout: 10000 })
      const p = await rect(popup(page))
      const r = await rowTop(page, target)
      const first = await rowTop(page, 'Vehicle')
      assert(Math.abs(p.y - r) <= 6, `${target}: box top ${p.y} must sit on its row ${r}`)
      assert(Math.abs(p.y - first) > 6 || Math.abs(r - first) <= 6, `${target}: box must not sit on the first row`)
      assert.equal(await popup(page).inputValue(), target, `${target}: box holds that row's name`)
      const font = async (locator) => locator.evaluate(e => getComputedStyle(e).fontFamily)
      assert.equal(await font(popup(page)), await font(row(page, target).locator('.m-tlabel')), `${target}: box must use the row's font`)
      // Typing straight away must reach the box (it opens focused, with the name selected, as
      // FLTK's popup does): the first character replaces the selected name.
      assert.equal(await popup(page).evaluate(e => document.activeElement === e), true, `${target}: box must have the keyboard`)
      await page.keyboard.type('X')
      assert.equal(await popup(page).inputValue(), 'X', `${target}: typing without clicking the box must work`)
      await page.keyboard.press('Escape')
      await popup(page).waitFor({ state: 'detached', timeout: 10000 })
    }
    assert.deepEqual((await names(page)).sort(), [...baseline].sort(), 'Escape must not rename')
    assert.deepEqual(errors, [])
    await page.close()
    console.log('PASS: box sits on its row, takes focus, matches the row font; Escape closes it')
  }

  // Ctrl+S while editing commits the field before invoking the actual File > Save item.
  {
    const { page, errors } = await open()
    await row(page, 'FuselageGeom').locator('.m-tlabel').dblclick()
    await popup(page).waitFor({ timeout: 10000 })
    await popup(page).fill('Saved Rename')
    const result = await page.evaluate(async () => {
      const { useMirror } = await import('/src/mirror/store.ts')
      const state = useMirror.getState()
      const bar = Object.values(state.widgets).find(w => w.k === 'menubar')
      const save = bar.items.find(item => item.label.replaceAll('&', '') === 'Save...')
      const events = []
      useMirror.setState({ send: event => events.push(event) })
      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
      document.activeElement.dispatchEvent(event)
      return { events, prevented: event.defaultPrevented, bar: bar.id, save: save.i }
    })
    assert.equal(result.prevented, true, 'Ctrl+S must not open the browser save dialog')
    assert.deepEqual(result.events.map(e => e.op), ['set', 'pick'], 'edit commits before saving')
    assert.equal(result.events[0].v, 'Saved Rename')
    assert.equal(result.events[1].id, result.bar)
    assert.equal(result.events[1].i, result.save)
    assert.deepEqual(errors, [])
    await page.close()
    console.log('PASS: Ctrl+S commits the focused edit and invokes File > Save')
  }

  // Root rows have expand controls and their own stacking level. The input must be on top,
  // receive pointer events, and commit a Vehicle rename rather than merely being focused.
  {
    const { page, errors } = await open()
    await row(page, 'Vehicle').locator('.m-tlabel').dblclick()
    await popup(page).waitFor({ timeout: 10000 })
    const box = await rect(popup(page))
    assert(Math.abs(box.y - await rowTop(page, 'Vehicle')) <= 6, 'Vehicle popup must sit on the root row')
    assert.equal(await popup(page).evaluate(e => {
      const r = e.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === e
    }), true, 'Vehicle popup must be above the root label and receive pointer events')
    await popup(page).click()
    await popup(page).fill('Renamed Vehicle')
    await page.keyboard.press('Enter')
    await popup(page).waitFor({ state: 'detached', timeout: 10000 })
    await row(page, 'Renamed Vehicle').waitFor({ timeout: 10000 })
    assert.deepEqual(errors, [])
    await page.close()
    console.log('PASS: Vehicle rename popup is above the root row and commits')
  }

  // 2. Enter commits to the edited row.
  {
    const { page, errors, baseline } = await open()
    await row(page, 'FuselageGeom').locator('.m-tlabel').dblclick()
    await popup(page).waitFor({ timeout: 10000 })
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Renamed Enter')
    await page.keyboard.press('Enter')
    await popup(page).waitFor({ state: 'detached', timeout: 10000 })
    const after = await names(page)
    assert.ok(after.includes('Renamed Enter'), `Enter must rename: ${after}`)
    assert.ok(!after.includes('FuselageGeom'), `the old name must be gone: ${after}`)
    assert.ok(after.includes('StackGeom'), `other geoms keep their names: ${after}`)
    assert.equal(after.length, baseline.length)
    assert.deepEqual(errors, [])
    await page.close()
    console.log('PASS: Enter commits')
  }

  // 3. Clicking another row commits to the edited row and closes the box.
  {
    const { page, errors, baseline } = await open()
    await row(page, 'FuselageGeom').locator('.m-tlabel').dblclick()
    await popup(page).waitFor({ timeout: 10000 })
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Renamed Away')
    await row(page, 'StackGeom').locator('.m-tlabel').click()
    await popup(page).waitFor({ state: 'detached', timeout: 10000 })
    const after = await names(page)
    assert.ok(after.includes('Renamed Away'), `clicking another row must commit to the edited row: ${after}`)
    assert.ok(after.includes('StackGeom'), `the clicked row must keep its name: ${after}`)
    assert.equal(after.length, baseline.length)
    assert.deepEqual(errors, [])
    await page.close()
    console.log('PASS: clicking another row commits to the edited row and closes the box')
  }

  // 4. Clicking empty canvas commits and closes.
  {
    const { page, errors, baseline } = await open()
    await row(page, 'FuselageGeom').locator('.m-tlabel').dblclick()
    await popup(page).waitFor({ timeout: 10000 })
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Renamed Canvas')
    const c = await page.locator('canvas').first().boundingBox()
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2)
    await popup(page).waitFor({ state: 'detached', timeout: 10000 })
    const after = await names(page)
    assert.ok(after.includes('Renamed Canvas'), `canvas click must commit: ${after}`)
    assert.equal(after.length, baseline.length)
    assert.deepEqual(errors, [])
    await page.close()
    console.log('PASS: clicking the canvas commits and closes the box')
  }
} finally {
  if (browser) await browser.close()
  vite.kill('SIGTERM')
  await new Promise(resolve => vite.exitCode !== null || vite.signalCode !== null ? resolve() : vite.once('exit', resolve))
}
