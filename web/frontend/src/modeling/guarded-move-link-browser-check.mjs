// Real-browser regression using an isolated Vite test server backed by production WASM.
// Example (from web/frontend):
// WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/guarded-move-link-browser-check.mjs
// WEBVSP_TEST_PAGE may override http://127.0.0.1:5179/; the server must provide the
// dev-only guarded test hook and cross-origin isolation. No host model files are used.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM to a Chromium executable')

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => window.crossOriginIsolated), true, 'browser must be cross-origin isolated')

  const request = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  const source = (await request('POST', '/geoms', { type: 'POD' })).id
  const target = (await request('POST', '/geoms', { type: 'POD' })).id
  const model = await request('GET', '/model')
  assert.equal(model.modelEpochValid, true)
  assert.notEqual(source, target)

  async function parameter(geom, group, name) {
    const ids = await request('GET', `/geoms/${geom}/parms`)
    const values = await Promise.all(ids.map(id => request('GET', `/geoms/${geom}/parms/${id}`)))
    const matches = values.filter(p => p.group === group && p.name === name && p.container === geom)
    assert.equal(matches.length, 1, `Expected unique ${group}/${name}`)
    return matches[0]
  }
  const length = await parameter(target, 'Design', 'Length')
  const readLength = async () => (await request('GET', `/geoms/${target}/parms/${length.id}`)).value
  const guardedMove = delta => page.evaluate(({ source, delta, epoch }) => window.__webvspEngine.testCallGuarded('move', source, `${delta},0,0`, 0, epoch), { source, delta, epoch: model.modelEpoch })
  const origin = () => request('GET', `/geoms/${source}/origin`)
  const before = await readLength(), originBefore = await origin()
  const firstResult = await guardedMove(2)
  const noLink = await readLength(), originNoLink = await origin()
  assert.equal(firstResult.ok, true, 'control guarded move must report success')
  assert.equal(noLink, before, 'unlinked target must remain unchanged')
  assert.ok(Math.abs(originNoLink[0] - originBefore[0] - 2) < 1e-8, 'control guarded move must move source')

  await page.locator('.m-menubar').getByRole('button', { name: 'Model', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'Link...', exact: true }).click()
  const select = page.locator('select')
  await select.nth(3).selectOption({ label: '2-PodGeom' })
  await page.waitForFunction(() => [...document.querySelectorAll('select')][4]?.innerText.includes('XForm'))
  await select.nth(4).selectOption({ label: 'XForm' })
  await page.waitForFunction(() => [...document.querySelectorAll('select')][5]?.innerText.includes('X_Rel_Location'))
  await select.nth(5).selectOption({ label: 'X_Rel_Location' })
  await select.nth(6).selectOption({ label: '3-PodGeom' })
  await page.waitForFunction(() => [...document.querySelectorAll('select')][7]?.innerText.includes('Design'))
  await select.nth(7).selectOption({ label: 'Design' })
  await page.waitForFunction(() => [...document.querySelectorAll('select')][8]?.innerText.includes('Length'))
  await select.nth(8).selectOption({ label: 'Length' })

  // A row in the actual link browser, not the drop-down choices, proves Add Link succeeded.
  const linkRow = page.locator('.m-bline').filter({ has: page.locator('.m-bcell', { hasText: 'X_Rel_Location' }) }).filter({ has: page.locator('.m-bcell', { hasText: 'Length' }) })
  assert.equal(await linkRow.count(), 0, 'link must not exist before Add Link')
  await page.getByRole('button', { name: 'Add Link', exact: true }).click()
  await linkRow.waitFor({ state: 'visible', timeout: 10000 })
  assert.deepEqual(await linkRow.locator('.m-bcell').allTextContents(), ['PodGeom', 'XForm', 'X_Rel_Location', '->', 'PodGeom', 'Design', 'Length'])

  const linkedBefore = await readLength(), originLinkedBefore = await origin()
  const secondResult = await guardedMove(3)
  const linkedAfter = await readLength(), originLinkedAfter = await origin()
  assert.equal(secondResult.ok, true, 'linked guarded move must report success')
  assert.ok(Math.abs(originLinkedAfter[0] - originLinkedBefore[0] - 3) < 1e-8, 'linked guarded move must move source')
  assert.ok(Math.abs(linkedAfter - linkedBefore - 3) < 1e-8, 'ordinary link must propagate guarded move to target length')
  assert.deepEqual(errors, [], 'browser must not emit page errors')
  console.log(JSON.stringify({ source, target, epoch: model.modelEpoch, firstResult, secondResult, unlinked: { sourceBefore: originBefore, sourceAfter: originNoLink, targetBefore: before, targetAfter: noLink }, linked: { sourceBefore: originLinkedBefore, sourceAfter: originLinkedAfter, targetBefore: linkedBefore, targetAfter: linkedAfter } }, null, 2))
  console.log('PASS: GUI normal parameter link propagates guarded move; unlinked control is unchanged')
} finally {
  await browser.close()
}
