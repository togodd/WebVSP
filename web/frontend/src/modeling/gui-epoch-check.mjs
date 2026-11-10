// Real GUI menu and dialogs, with in-memory file handles (not native picker permissions).
// Run from web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/gui-epoch-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    let bytes = null
    window.__picker = { saves: 0, opens: 0, mode: 'good' }
    const good = {
      name: 'epoch.vsp3', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      getFile: async () => new File([bytes], 'epoch.vsp3'),
      createWritable: async () => ({ write: async b => { bytes = new Uint8Array(b) }, close: async () => { window.__picker.saves++; window.__picker.size = bytes.length } }),
    }
    const bad = { name: 'bad.vsp3', getFile: async () => new File(['not a vsp3 file'], 'bad.vsp3') }
    window.showSaveFilePicker = async () => good
    window.showOpenFilePicker = async () => {
      window.__picker.opens++
      if (window.__picker.mode === 'cancel') throw new DOMException('Cancelled', 'AbortError')
      return [window.__picker.mode === 'bad' ? bad : good]
    }
  })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    window.__service = createBrowserModelingService()
  })
  const req = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  const info = () => page.evaluate(() => window.__service.model.getInfo())
  const menu = async name => {
    await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
    await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
  }
  const setMode = mode => page.evaluate(mode => { window.__picker.mode = mode }, mode)
  const open = async mode => {
    await setMode(mode)
    const count = await page.evaluate(() => window.__picker.opens)
    await menu('Open...')
    await page.waitForFunction(count => window.__picker.opens > count, count, { timeout: 30000 })
  }
  const changed = async old => {
    await page.waitForFunction(epoch => window.__webvspEngine.testCall('model').then(m => m.modelEpochValid && m.modelEpoch !== epoch), old.modelEpoch, { timeout: 30000 })
    const current = (await info()).identity
    assert.equal(current.sessionId, old.sessionId)
    assert.notEqual(current.modelEpoch, old.modelEpoch)
    return current
  }
  const stale = async old => {
    const result = await page.evaluate(async old => {
      try { await window.__service.model.getInfo(old); return 'SUCCEEDED' } catch (e) { return e.code }
    }, old)
    assert.equal(result, 'STALE_MODEL')
    const before = await req('GET', '/model')
    const guarded = await page.evaluate(async epoch => {
      try { await window.__webvspEngine.testCallGuarded('addGeom', 'WING', '', 0, epoch); return { code: 'SUCCEEDED' } }
      catch (e) { return { code: e.code, outcome: e.outcome } }
    }, old.modelEpoch)
    assert.deepEqual(guarded, { code: 'STALE_MODEL', outcome: 'not_written' })
    assert.deepEqual((await req('GET', '/model')).geoms, before.geoms)
  }
  await req('POST', '/geoms', { type: 'FUSELAGE' })
  const initial = await info()
  assert.equal(initial.geometries.length, 1)
  await menu('Save As...')
  await page.waitForFunction(() => window.__picker.saves > 0, { timeout: 30000 })
  assert.ok(await page.evaluate(() => window.__picker.size > 0))
  const saved = await info()
  assert.deepEqual(saved.identity, initial.identity)

  await menu('New')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.deepEqual((await info()).identity, saved.identity)
  assert.deepEqual((await info()).geometries, saved.geometries)

  await menu('New')
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click()
  const empty = await changed(saved.identity)
  assert.equal((await info()).geometries.length, 0)
  await stale(saved.identity)

  await open('good')
  const reopened = await changed(empty)
  await page.waitForFunction(() => window.__webvspEngine.testCall('model').then(m => m.geoms.length === 1), { timeout: 30000 })
  assert.equal((await info()).geometries.length, 1)
  await stale(empty)

  await open('cancel')
  // Wait for the asynchronous picker cancellation to be processed through the GUI.
  await page.waitForTimeout(500)
  assert.deepEqual((await info()).identity, reopened)
  assert.equal((await info()).geometries.length, 1)

  // Reopening the very same saved file is still replacement, not the same model.
  await open('good')
  const reopenedAgain = await changed(reopened)
  assert.equal((await info()).geometries.length, 1)
  await stale(reopened)

  // An invalid file is destructive: the GUI renews before attempting the read.
  await open('bad')
  const afterBad = await changed(reopenedAgain)
  assert.equal((await info()).geometries.length, 0)
  await stale(reopenedAgain)
  assert.notEqual(afterBad.modelEpoch, reopenedAgain.modelEpoch)
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__service.close())
  console.log('PASS: GUI New cancel/discard, Open cancel/same/invalid, epoch and stale guards')
} finally { await browser.close() }
