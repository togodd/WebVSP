// Requires vite.modeling-test.config.ts backed by a WASM build from the same checkout.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5178/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const request = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  const wing = (await request('POST', '/geoms', { type: 'WING' })).id
  const fuselage = (await request('POST', '/geoms', { type: 'FUSELAGE' })).id
  const surfaces = await request('GET', `/geoms/${wing}/xsecs`)
  const ids = await request('GET', `/geoms/${wing}/parms`)
  assert.ok(surfaces.length && surfaces[0].xsecs.length && ids.length)
  const parameter = await request('GET', `/geoms/${wing}/parms/${ids[0]}`)
  assert.equal(parameter.id, ids[0]); assert.equal(typeof parameter.value, 'number')
  const section = surfaces[0].xsecs[0]
  const sectionIds = await request('GET', `/xsecs/${section}/parms`)
  assert.ok(sectionIds.length)
  assert.equal((await request('GET', `/xsecs/${section}/parms/${sectionIds[0]}`)).id, sectionIds[0])
  await assert.rejects(() => request('GET', `/geoms/${fuselage}/parms/${ids[0]}`))
  await assert.rejects(() => request('GET', '/xsecs/NOTREAL/parms'))
  await assert.rejects(() => request('GET', '/geoms/NOTREAL/parms'))
  await request('POST', '/geoms/delete', { ids: [wing] })
  await assert.rejects(() => request('GET', `/xsecs/${section}/parms`))
  assert.deepEqual(errors, [])
  console.log('PASS: geometry and cross-section parameter ownership, metadata and stale references')
} finally {
  await browser.close()
}
