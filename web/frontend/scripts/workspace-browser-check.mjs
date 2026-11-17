// Real Chromium check for the workspace panel: list, filter, preview, delete.
//   WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... \
//   WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/workspace-browser-check.mjs
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const { WEBVSP_TEST_PAGE: base, WEBVSP_TEST_CHROMIUM: executablePath, WEBVSP_TEST_WASM_DIR: dir } = process.env
if (!base || !executablePath || !dir) throw Error('Set WEBVSP_TEST_PAGE, WEBVSP_TEST_CHROMIUM and WEBVSP_TEST_WASM_DIR')
const url = new URL(base)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('A disposable loopback server is required')
const files = Object.fromEntries(await Promise.all(['vsp.js', 'vsp.wasm'].map(async name => {
  const path = resolve(dir, name)
  const [body, info] = await Promise.all([readFile(path), stat(path)])
  return [name, { path, body, hash: createHash('sha256').update(body).digest('hex') }]
})))
// A real .vsp3 from the repository: opening it must replace the live model, which a
// hand-written stub cannot prove.
const fixture = resolve(dir, '../../../src/test/py/tests/wing.vsp3')

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const request = new URL(route.request().url())
    if (request.origin !== url.origin) return route.abort()
    const match = request.pathname.match(/\/wasm\/(vsp\.js|vsp\.wasm)$/)
    if (match) {
      return route.fulfill({ status: 200, body: files[match[1]].body, headers: { 'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
    }
    return route.continue()
  })
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)

  const modelBytes = await readFile(fixture).catch(() => { throw Error(`Missing model fixture: ${fixture}`) })
  await page.evaluate(async (bytes) => {
    const { engineWriteFile } = await import('/src/api/wasmEngine.ts')
    const enc = new TextEncoder()
    await engineWriteFile('/work/demo/model.vsp3', new Uint8Array(bytes))
    await engineWriteFile('/work/demo/sweep.csv', enc.encode('Alpha,CLtot\n-5,-0.41\n0,0.0\n'))
    await engineWriteFile('/work/demo/notes.txt', enc.encode('hello workspace\n'))
  }, [...modelBytes])

  await page.click('[data-testid="workspace-open"]')
  await page.waitForSelector('[data-testid="workspace-panel"]', { timeout: 15000 })
  await page.waitForTimeout(400)
  assert.equal(await page.locator('[data-testid="workspace-panel"]').evaluate((el) => getComputedStyle(el).position), 'relative')
  assert.equal(await page.locator('[data-testid="workspace-panel"] button[title="刷新"]').count(), 0)
  assert.equal(await page.locator('[data-testid="workspace-panel"] button:has-text("选择文件夹")').count(), 0)
  assert.equal(await page.locator('[data-testid="workspace-panel"] button:has-text("添加文件")').count(), 0)
  assert.equal(await page.locator('[data-testid="workspace-panel"] button:has-text("同步")').count(), 0)

  // The list shows every file with its kind glyph.
  assert.equal(await page.locator('.ws-row').count(), 3)
  assert.equal((await page.textContent('[data-testid="ws-count"]') ?? '').trim(), '3 个文件')
  assert.equal(await page.locator('.ws-kind-model').count(), 1)
  assert.equal(await page.locator('.ws-kind-table').count(), 1)
  assert.equal(await page.locator('.ws-row button[title="查看"] svg').count(), 3)
  assert.equal(await page.locator('.ws-row button[title="下载"] svg').count(), 3)
  assert.equal(await page.locator('.ws-row button[title="删除"] svg').count(), 3)
  console.log('PASS lists files with typed icons')

  // Filtering narrows the list and an empty result explains itself.
  await page.fill('[data-testid="ws-search"]', 'csv')
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.ws-row').count(), 1)
  await page.fill('[data-testid="ws-search"]', 'zzz')
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.ws-row').count(), 0)
  assert.match((await page.textContent('.ws-empty')) ?? '', /没有匹配/)
  await page.fill('[data-testid="ws-search"]', '')
  await page.waitForTimeout(150)
  console.log('PASS filters by name')

  // Both directions must sort the real byte size, and the arrow follows it.
  const names = () => page.locator('.ws-row .ws-name').allTextContents()
  const sizeHeader = page.locator('.ws-head button.ws-size')
  await sizeHeader.click()
  assert.deepEqual(await names(), ['demo/model.vsp3', 'demo/sweep.csv', 'demo/notes.txt'])
  assert.match(await sizeHeader.innerText(), /↓/)
  await sizeHeader.click()
  assert.deepEqual(await names(), ['demo/notes.txt', 'demo/sweep.csv', 'demo/model.vsp3'])
  assert.match(await sizeHeader.innerText(), /↑/)
  const timeHeader = page.locator('.ws-head button.ws-time')
  await timeHeader.click()
  assert.match(await timeHeader.innerText(), /↓/)
  await timeHeader.click()
  assert.match(await timeHeader.innerText(), /↑/)
  console.log('PASS toggles numeric size and time sorting')

  // Header and row columns use identical grid tracks even with a scrollbar.
  const aligned = await page.locator('.ws-list').evaluate((list) => {
    const head = list.querySelector('.ws-head')
    const row = list.querySelector('.ws-row')
    return [...head.children].map((cell, i) => Math.abs(cell.getBoundingClientRect().x - row.children[i].getBoundingClientRect().x))
  })
  assert.ok(aligned.every((delta) => delta < 1), `misaligned columns: ${aligned}`)
  console.log('PASS aligns table header and rows')

  // Dragging adjusts the docked width and persists it only after release.
  const panel = page.locator('[data-testid="workspace-panel"]')
  const handle = panel.locator('.ws-resize')
  const beforeWidth = (await panel.boundingBox()).width
  const handleBox = await handle.boundingBox()
  await page.mouse.move(handleBox.x + 4, handleBox.y + 40)
  await page.mouse.down()
  await page.mouse.move(handleBox.x - 76, handleBox.y + 40, { steps: 8 })
  await page.mouse.up()
  const afterWidth = (await panel.boundingBox()).width
  assert.ok(afterWidth > beforeWidth + 50, `resize failed: ${beforeWidth} -> ${afterWidth}`)
  assert.ok(Math.abs(Number(await page.evaluate(() => localStorage.getItem('webvsp.workspace.width'))) - afterWidth) < 2)
  console.log('PASS drags and persists sidebar width')

  // Preview shows file contents.
  await page.click('.ws-row:has-text("sweep.csv") button[title="查看"]')
  await page.waitForSelector('.ws-preview-text', { timeout: 10000 })
  assert.match((await page.textContent('.ws-preview-text')) ?? '', /Alpha,CLtot/)
  await page.click('.ws-modal-foot button:has-text("关闭")')
  await page.waitForSelector('.ws-preview-text', { state: 'detached', timeout: 5000 })
  console.log('PASS previews a text file')

  // A binary file explains why it cannot be previewed.
  await page.evaluate(async () => {
    const { engineWriteFile } = await import('/src/api/wasmEngine.ts')
    await engineWriteFile('/work/demo/run.adb', new Uint8Array([0, 1, 2, 3]))
  })
  // The side panel observes engine writes without a manual refresh.
  await page.locator('.ws-row:has-text("run.adb")').waitFor({ timeout: 6000 })
  await page.click('.ws-row:has-text("run.adb") button[title="查看"]')
  await page.waitForTimeout(400)
  assert.match((await page.textContent('.ws-modal-body')) ?? '', /二进制文件/)
  await page.click('.ws-modal-foot button:has-text("关闭")')
  console.log('PASS refuses to preview a binary file')

  // Delete asks first, then removes the file.
  await page.click('.ws-row:has-text("notes.txt") button[title="删除"]')
  await page.waitForSelector('.ws-confirm', { timeout: 5000 })
  await page.click('.ws-confirm button:has-text("取消")')
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.ws-row').count(), 4)
  await page.click('.ws-row:has-text("notes.txt") button[title="删除"]')
  await page.waitForSelector('.ws-confirm', { timeout: 5000 })
  await page.click('.ws-confirm .danger')
  await page.waitForTimeout(600)
  assert.equal(await page.locator('.ws-row').count(), 3)
  assert.match((await page.textContent('.ws-status')) ?? '', /已删除/)
  console.log('PASS deletes after confirmation')

  // The context menu opens on right click.
  await page.click('.ws-row:has-text("model.vsp3")', { button: 'right' })
  await page.waitForSelector('.ws-menu', { timeout: 5000 })
  assert.equal(await page.locator('.ws-menu button').count(), 3)
  await page.keyboard.press('Escape')
  await page.click('[data-testid="ws-search"]')
  console.log('PASS opens a context menu')

  // Opening a real VSP3 must be confirmed and replace the live model; the 3D view
  // shows the model in memory, so the panel marks which file it came from.
  const modelRow = page.locator('.ws-row:has-text("model.vsp3")')
  const confirmOpen = page.getByRole('dialog', { name: '打开模型确认' })
  const opened = async () => {
    await confirmOpen.getByRole('button', { name: '继续打开' }).click()
    await confirmOpen.waitFor({ state: 'detached', timeout: 60000 })
  }
  await modelRow.locator('button[title="查看"]').click()
  await confirmOpen.waitFor()
  await confirmOpen.getByRole('button', { name: '取消' }).click()
  assert.equal(await page.locator('.ws-current').count(), 0)
  await modelRow.locator('button[title="查看"]').click()
  await opened()
  await page.waitForFunction(() => document.querySelector('.ws-current'))
  const loaded = await page.evaluate(() => ({
    model: null,
    label: document.querySelector('.viewer-file')?.textContent ?? '',
  }))
  assert.match(loaded.label, /来自工作区/)
  assert.ok(await page.locator('canvas').count(), '3D viewport canvas missing')
  console.log('PASS confirms and opens a real VSP3 model')

  // Double click uses the same confirmation; cancelling leaves the association unchanged.
  await modelRow.dblclick()
  await confirmOpen.waitFor()
  await confirmOpen.getByRole('button', { name: '取消' }).click()
  assert.match((await page.textContent('.viewer-file')) ?? '', /来自工作区/)
  await modelRow.dblclick()
  await opened()
  assert.match((await page.textContent('.viewer-file')) ?? '', /来自工作区/)
  console.log('PASS double click confirms or cancels the same way')

  // Deleting the associated file warns, and the live model survives without it.
  await modelRow.locator('button[title="删除"]').click()
  const deleteModel = page.getByRole('dialog', { name: '删除文件' })
  assert.match(await deleteModel.innerText(), /当前模型关联/)
  await deleteModel.locator('.danger').click()
  await modelRow.waitFor({ state: 'detached' })
  await page.waitForFunction(() => /工作区文件已删除/.test(document.querySelector('.viewer-file')?.textContent ?? ''))
  console.log('PASS deleting the associated file keeps the model and marks it missing')

  // A file that is not a VSP3 reports the failure and keeps no association.
  await page.evaluate(async () => {
    const { engineWriteFile } = await import('/src/api/wasmEngine.ts')
    await engineWriteFile('/work/demo/bad.vsp3', new TextEncoder().encode('not a VSP3'))
  })
  const badRow = page.locator('.ws-row:has-text("bad.vsp3")')
  await badRow.waitFor()
  await badRow.locator('button[title="查看"]').click()
  await confirmOpen.getByRole('button', { name: '继续打开' }).click()
  const failure = page.getByRole('alertdialog', { name: '打开模型失败' })
  await failure.waitFor({ timeout: 60000 })
  assert.equal(await page.locator('.ws-current').count(), 0)
  await failure.getByRole('button', { name: '关闭' }).click()
  console.log('PASS reports a failed model read')

  // Close, mutate the engine, then reopen: the initial listing must not be stale.
  await page.locator('[data-testid="workspace-panel"] button[title="关闭"]').click()
  await page.waitForSelector('[data-testid="workspace-panel"]', { state: 'detached' })
  await page.evaluate(async () => {
    const { engineWriteFile } = await import('/src/api/wasmEngine.ts')
    await engineWriteFile('/work/demo/reopened.txt', new TextEncoder().encode('new'))
  })
  await page.click('[data-testid="workspace-open"]')
  await page.locator('.ws-row:has-text("reopened.txt")').waitFor({ timeout: 6000 })
  console.log('PASS reloads the current filesystem on reopen')

  if (errors.length) throw Error(`page errors: ${JSON.stringify(errors)}`)
} finally { await browser.close() }
