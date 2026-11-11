// Disposable, GUI-only model mutations: compare a fresh model to models after
// three distinct invalid GUI Opens. Each scenario uses a fresh browser context.
// No valid Open, native picker, or host model file is used. Exit 0 requires all
// GUI links to propagate and each Open to reach its intended failure branch.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/failed-open-gui-link-browser-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/. Evidence directory can be
// set with WEBVSP_TEST_EVIDENCE; defaults to /tmp/webvsp-failed-open-gui-link.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const evidenceDir = process.env.WEBVSP_TEST_EVIDENCE ?? '/tmp/webvsp-failed-open-gui-link'
await mkdir(evidenceDir, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const results = []
const scenarios = [
  { name: 'control' },
  { name: 'wrong-root', contents: '<?xml version="1.0"?><Not_Vsp_Geometry/>', diagnostic: 'document of the wrong type' },
  { name: 'old-version', contents: '<?xml version="1.0"?><Vsp_Geometry><Version>0</Version></Vsp_Geometry>', diagnostic: 'document version not supported' },
  { name: 'non-xml', contents: 'not xml', diagnostic: 'could not parse XML document' },
]
try {
  for (const testCase of scenarios) {
    const scenario = testCase.name
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    const result = { scenario, steps: [], errors: [] }
    results.push(result)
    page.on('pageerror', error => result.errors.push(error.message))
    result.console = []
    page.on('console', message => result.console.push({ type: message.type(), text: message.text() }))
    try {
      await page.addInitScript(({ contents, name }) => {
        window.__testPicker = { opens: 0 }
        window.showOpenFilePicker = async () => {
          window.__testPicker.opens++
          return [{ name: `${name}.vsp3`, getFile: async () => new File([contents], `${name}.vsp3`) }]
        }
      }, { contents: testCase.contents ?? '', name: scenario })
      await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      assert.equal(await page.evaluate(() => crossOriginIsolated), true)
      const req = (method, path) => page.evaluate(({ method, path }) => window.__webvspEngine.request(method, path), { method, path })
      const model = () => req('GET', '/model')
      const menu = async (top, item) => {
        await page.locator('.m-menubar').getByRole('button', { name: top, exact: true }).click()
        await page.locator('.menu-list').getByRole('button', { name: item, exact: true }).click()
      }
      const initial = await model()
      assert.equal(initial.geoms.length, 0)
      result.initial = initial
      if (testCase.contents) {
        await menu('File', 'Open...')
        await page.waitForFunction(epoch => window.__webvspEngine.request('GET', '/model').then(m => m.modelEpoch !== epoch), initial.modelEpoch, { timeout: 30000 })
        result.afterOpen = await model()
        result.pickerOpens = await page.evaluate(() => window.__testPicker.opens)
        assert.equal(result.pickerOpens, 1)
        assert.equal(result.afterOpen.geoms.length, 0)
        result.diagnosticObserved = result.console.some(entry => entry.text.includes(testCase.diagnostic))
        assert.ok(result.diagnosticObserved, `${scenario}: expected parse failure diagnostic`)
        result.steps.push(`${scenario} Open completed; no valid Open`)
      }
      // Create both pods via the Geom Browser, not engine mutation endpoints.
      for (let n = 1; n <= 2; n++) {
        await page.locator('select').first().selectOption({ label: 'POD' })
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await page.waitForFunction(n => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === n), n, { timeout: 30000 })
      }
      const created = await model()
      result.created = created
      result.steps.push('created two PODs with GUI Add')
      const [source, target] = created.geoms.map(g => g.id)
      await menu('Model', 'Link...')
      const linkWindow = page.locator('.m-window-outer').filter({ hasText: 'Parm Link: ( A * Scale + Offset = B )' })
      const selects = linkWindow.locator('select')
      await selects.nth(0).selectOption({ label: '2-PodGeom' })
      await selects.nth(1).selectOption({ label: 'XForm', timeout: 10000 })
      await selects.nth(2).selectOption({ label: 'X_Rel_Location', timeout: 10000 })
      await selects.nth(3).selectOption({ label: '3-PodGeom' })
      await selects.nth(4).selectOption({ label: 'Design', timeout: 10000 })
      await selects.nth(5).selectOption({ label: 'Length', timeout: 10000 })
      const row = page.locator('.m-bline').filter({ has: page.locator('.m-bcell', { hasText: 'X_Rel_Location' }) }).filter({ has: page.locator('.m-bcell', { hasText: 'Length' }) })
      assert.equal(await row.count(), 0)
      await page.getByRole('button', { name: 'Add Link', exact: true }).click()
      await row.waitFor({ state: 'visible', timeout: 10000 })
      result.linkRow = await row.locator('.m-bcell').allTextContents()
      assert.deepEqual(result.linkRow, ['PodGeom', 'XForm', 'X_Rel_Location', '->', 'PodGeom', 'Design', 'Length'])
      result.steps.push('GUI link row created')
      const ids = await req('GET', `/geoms/${target}/parms`)
      const parms = await Promise.all(ids.map(id => req('GET', `/geoms/${target}/parms/${id}`)))
      const matches = parms.filter(p => p.name === 'Length' && p.group === 'Design' && p.container === target)
      assert.equal(matches.length, 1)
      const readLength = async () => (await req('GET', `/geoms/${target}/parms/${matches[0].id}`)).value
      // Close the overlapping floating Link window before selecting the source.
      await page.locator('.m-float').filter({ hasText: 'Parm Link: ( A * Scale + Offset = B )' }).locator('.m-float-title button').click()
      // GUI tree selection, then a real mirrored XForm input; never POST /pick.
      result.treeHtml = await page.locator('.m-tree').allTextContents()
      const tree = page.locator('.m-tree')
      await tree.getByText('PodGeom', { exact: true }).first().click()
      await page.locator('.m-tabbar').getByRole('button', { name: 'XForm', exact: true }).click()
      const x = page.locator('.m-w.m-input[title*="XForm:X_Rel_Location"] input')
      await x.waitFor({ state: 'visible', timeout: 30000 })
      const before = await readLength(), oldX = Number(await x.inputValue())
      result.before = { source, target, oldX, targetLength: before }
      await x.fill(String(oldX + 3))
      await x.press('Enter')
      await page.waitForFunction(async ({ id, expected }) => Math.abs((await window.__webvspEngine.request('GET', `/geoms/${id}/origin`))[0] - expected) < 1e-6, { id: source, expected: oldX + 3 }, { timeout: 30000 })
      // Allow mirror/engine updates to settle, then retain the actual values even on failure.
      await page.waitForTimeout(2000)
      result.after = { sourceOrigin: await req('GET', `/geoms/${source}/origin`), targetLength: await readLength() }
      assert.ok(Math.abs(result.after.sourceOrigin[0] - (oldX + 3)) < 1e-6, 'GUI source edit must change source')
      result.propagated = Math.abs(result.after.targetLength - (before + 3)) < 1e-6
      result.frozen = Math.abs(result.after.targetLength - before) < 1e-6
      assert.ok(result.propagated, `${scenario}: GUI source edit must propagate +3 to target`)
      result.steps.push(`${scenario}: GUI source edit propagated +3 to target`)
      assert.deepEqual(result.errors, [])
      result.pass = true
    } catch (error) {
      result.pass = false
      result.error = error.stack ?? String(error)
      try { result.body = await page.locator('body').innerText({ timeout: 3000 }) } catch {}
    } finally {
      try { await page.screenshot({ path: `${evidenceDir}/${scenario}.png`, timeout: 10000 }) } catch (error) { result.screenshotError = String(error) }
      await writeFile(`${evidenceDir}/${scenario}.json`, JSON.stringify(result, null, 2))
      console.log(JSON.stringify(result, null, 2))
      await context.close()
    }
  }
} finally { await browser.close() }
console.log(`Evidence: ${evidenceDir}`)
if (results.some(result => !result.pass)) process.exitCode = 1
