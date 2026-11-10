// GUI save/reopen with an in-memory picker: no real filesystem permissions are tested.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    let bytes = null
    window.__test = { saves: 0, opens: 0 }
    const handle = {
      name: 'persistence.vsp3', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      getFile: async () => new File([bytes], 'persistence.vsp3'),
      createWritable: async () => ({ write: async b => { bytes = new Uint8Array(b) }, close: async () => { window.__test.saves++; window.__test.size = bytes.length } }),
    }
    window.showSaveFilePicker = async () => handle
    window.showOpenFilePicker = async () => { window.__test.opens++; return [handle] }
  })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const req = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  const fuse = (await req('POST', '/geoms', { type: 'FUSELAGE' })).id
  await req('POST', '/geoms', { type: 'WING', parent: fuse })
  async function parm(id, name, group) {
    for (const p of await req('GET', `/geoms/${id}/parms`)) {
      const result = await req('GET', `/geoms/${id}/parms/${p}`)
      if (result.name === name && result.group === group) return result
    }
    throw Error(`Missing parameter ${name}`)
  }
  const length = await parm(fuse, 'Length', 'Design')
  await req('PUT', `/geoms/${fuse}/parms/${length.id}`, { value: 20 })
  assert.equal((await parm(fuse, 'Length', 'Design')).value, 20)
  const menu = async name => {
    await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
    await page.locator('.menu-list').getByRole('button', { name, exact: true }).click()
  }
  await menu('Save As...')
  await page.waitForFunction(() => window.__test.saves > 0, { timeout: 30000 })
  assert.ok(await page.evaluate(() => window.__test.size > 0))
  await req('POST', '/file/new')
  assert.equal((await req('GET', '/model')).geoms.length, 0)
  await menu('Open...')
  await page.waitForFunction(() => window.__test.opens > 0, { timeout: 30000 })
  await page.waitForFunction(() => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === 2), { timeout: 30000 })
  const model = await req('GET', '/model')
  const f = model.geoms.find(g => g.type === 'Fuselage'), w = model.geoms.find(g => g.type === 'Wing')
  assert.ok(f && w); assert.equal(w.parent, f.id)
  assert.equal((await parm(f.id, 'Length', 'Design')).value, 20)
  assert.deepEqual(errors, [])
  console.log('PASS: GUI save/reopen hierarchy and parameter via in-memory file handle')
} finally { await browser.close() }
