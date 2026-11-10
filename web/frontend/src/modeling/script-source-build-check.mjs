// Disposable, isolated WASM compiled with WEBVSP_SCRIPT_GUARD_TEST only; never deploy.
// Serve with vite.modeling-test.config.ts. From web/frontend:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/script-source-build-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: source build check timed out'); process.exit(1) }, 240000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  // Each page owns a fresh WASM instance: sticky state has deliberately no reset.
  for (const scenario of ['failed', 'success']) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/', { timeout: 30000 })
    assert.ok(response?.ok())
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    const result = await page.evaluate(async scenario => {
      const engine = window.__webvspEngine
      const call = (op, a = '') => engine.testCall(op, a)
      const clean = await call('scriptSourceBuildState')
      const blocked = await call('scriptSourceBuildFixture', 'blocked')
      const afterBlocked = await call('scriptSourceBuildState')
      const built = await call('scriptSourceBuildFixture', scenario)
      const afterBuild = await call('scriptSourceBuildState')
      await engine.request('POST', '/file/new')
      const afterNewModel = await call('scriptSourceBuildState')
      return { clean, blocked, afterBlocked, built, afterBuild, afterNewModel }
    }, scenario)
    assert.equal(result.clean, false, `${scenario}: fresh process`)
    assert.deepEqual(result.blocked, { blocked: true, attempted: true })
    assert.equal(result.afterBlocked, false, `${scenario}: guard blocked before build`)
    assert.deepEqual(result.built, scenario === 'failed' ? { failed: true } : { success: true, removed: true })
    assert.equal(result.afterBuild, true, `${scenario}: attempted build must taint`)
    assert.equal(result.afterNewModel, true, `${scenario}: new model must not reset`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  // The existing test-only integration fixture actually calls AdvLink::BuildScript
  // before entering its execution guard; it also removes the link and its geoms.
  {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/', { timeout: 30000 })
    assert.ok(response?.ok())
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    const result = await page.evaluate(async () => {
      const engine = window.__webvspEngine
      const state = () => engine.testCall('scriptSourceBuildState')
      const clean = await state()
      const fixture = await engine.testCall('advLinkGuardCheck')
      const afterBuildAndRemoval = await state()
      await engine.request('POST', '/file/new')
      return { clean, fixture, afterBuildAndRemoval, afterNew: await state() }
    })
    assert.equal(result.clean, false, 'Advanced Link: fresh process')
    assert.equal(result.fixture.built, true, 'Advanced Link: real BuildScript succeeded')
    assert.equal(result.fixture.initial, false)
    assert.equal(result.fixture.attempted, true)
    assert.equal(result.fixture.guardedAlive, true)
    assert.equal(result.fixture.unguardedAlive, false)
    assert.equal(result.fixture.afterCleanup, result.fixture.before)
    assert.equal(result.afterBuildAndRemoval, true, 'Advanced Link: build taints after removal')
    assert.equal(result.afterNew, true, 'Advanced Link: new model cannot clear flag')
    assert.deepEqual(errors, [])
    await context.close()
  }
  // Construct an embedded Custom model from an in-memory GUI save, then open
  // it through the real file chooser and CustomGeom::DecodeXml path. No host
  // file handles, user profile, or pre-existing user model are involved.
  {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      let bytes = null
      window.__sourceProbe = { saves: 0, opens: 0, writesAfterOpen: 0, opened: false,
        getBytes: () => bytes, setBytes: value => { bytes = value } }
      const handle = {
        name: 'source-build-fixture.vsp3',
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        getFile: async () => new File([bytes], 'source-build-fixture.vsp3'),
        createWritable: async () => ({ write: async data => {
          if (window.__sourceProbe.opened) window.__sourceProbe.writesAfterOpen++
          bytes = new Uint8Array(data)
        }, close: async () => { window.__sourceProbe.saves++ } }),
      }
      window.showSaveFilePicker = async () => handle
      window.showOpenFilePicker = async () => { window.__sourceProbe.opens++; window.__sourceProbe.opened = true; return [handle] }
    })
    const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/', { timeout: 30000 })
    assert.ok(response?.ok())
    await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
    const call = op => page.evaluate(op => window.__webvspEngine.testCall(op), op)
    assert.equal(await call('scriptSourceBuildState'), false, 'Custom: fresh process')
    await page.evaluate(() => window.__webvspEngine.request('POST', '/geoms', { type: 'BLANK' }))
    const menu = async name => {
      await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
      await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
    }
    await menu('Save As...')
    await page.waitForFunction(() => window.__sourceProbe.saves > 0, { timeout: 30000 })
    assert.equal(await call('scriptSourceBuildState'), false, 'Custom: blank model save does not build source')
    await page.evaluate(() => {
      const probe = window.__sourceProbe
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(probe.getBytes()), 'application/xml')
      if (doc.querySelector('parsererror')) throw Error('Could not parse disposable model')
      const geoms = doc.querySelectorAll('Vehicle > Geom')
      if (geoms.length !== 1) throw Error(`Expected one fixture geom, got ${geoms.length}`)
      const geom = geoms[0]
      const base = geom.querySelector(':scope > GeomBase')
      base.querySelector('TypeName').textContent = 'Custom'
      base.querySelector('TypeID').textContent = '9'
      const custom = doc.createElement('CustomGeom')
      for (const [name, value] of [
        ['ScriptFileModule', 'WebVSP_SourceBuild_Custom'],
        ['ScriptFileContents', 'void Init() { AddParm(PARM_DOUBLE_TYPE, "SourceBuildProbe", "Probe"); } void InitGui() {} void UpdateGui() {} void UpdateSurf() {} void ComputeCenter() {} void Scale(double s) {}'],
      ]) {
        const node = doc.createElement(name); node.textContent = value; custom.appendChild(node)
      }
      geom.insertBefore(custom, geom.firstChild)
      probe.setBytes(new TextEncoder().encode(new XMLSerializer().serializeToString(doc)))
    })
    await page.evaluate(() => window.__webvspEngine.request('POST', '/file/new'))
    await menu('Open...')
    await page.waitForFunction(() => window.__sourceProbe.opens === 1, { timeout: 30000 })
    await page.waitForFunction(() => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === 1), { timeout: 30000 })
    const result = await page.evaluate(async () => {
      const engine = window.__webvspEngine
      const model = await engine.request('GET', '/model')
      const id = model.geoms[0].id
      const ids = await engine.request('GET', `/geoms/${id}/parms`)
      const parms = await Promise.all(ids.map(p => engine.request('GET', `/geoms/${id}/parms/${p}`)))
      const state = await engine.testCall('scriptSourceBuildState')
      await engine.request('POST', '/file/new')
      return { type: model.geoms[0].type, names: parms.map(p => p.name), state,
        afterNew: await engine.testCall('scriptSourceBuildState'), writes: window.__sourceProbe.writesAfterOpen }
    })
    assert.equal(result.type, 'Custom')
    assert.ok(result.names.includes('SourceBuildProbe'), 'Custom: embedded Init() must run')
    assert.equal(result.state, true, 'Custom: embedded source build taints')
    assert.equal(result.afterNew, true, 'Custom: new model cannot clear flag')
    assert.equal(result.writes, 0, 'Custom: opened fixture must not be written back')
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('PASS: source build diagnostic covers blocked, failed and successful sources, real Advanced Link and embedded Custom, with sticky state')
} finally {
  if (browser) await browser.close()
  clearTimeout(deadline)
}
