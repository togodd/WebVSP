// Run against a disposable isolated modeling test server with the matching WASM build.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const { WEBVSP_TEST_CHROMIUM: executablePath, WEBVSP_TEST_PAGE: url } = process.env
if (!executablePath || !url) throw new Error('Set WEBVSP_TEST_CHROMIUM and WEBVSP_TEST_PAGE')
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Test server must be loopback')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const e = window.__webvspEngine
    const call = (op, a = '', b = '', value = 0) => e.testCall(op, a, b, value)
    const fails = async (op, a = '', b = '', value = 0) => {
      try { await call(op, a, b, value); return false } catch (error) { return !!error.message }
    }
    await e.request('POST', '/file/new')
    const body = (await e.request('POST', '/geoms', { type: 'FUSELAGE' })).id
    const other = (await e.request('POST', '/geoms', { type: 'FUSELAGE' })).id
    const surfaces = await call('liveXSecSurfs', body)
    const sections = await call('liveXSecs', surfaces[0])
    const shape = await call('liveXSecShape', sections[1])
    const parms = await call('liveXSecParmIDs', sections[1])
    const before = sections.length
    await call('liveInsertXSec', body, '2', 1)
    const inserted = (await call('liveXSecs', surfaces[0])).length
    await call('liveDeleteXSec', body, '', 2)
    const restored = (await call('liveXSecs', surfaces[0])).length
    const sub = await call('liveAddSubSurf', body, '1', 0)
    const listed = await call('liveSubSurfs', body)
    const subType = await call('liveSubSurfType', sub)
    const wrongOwner = await fails('liveDeleteSubSurf', other, sub)
    const stillListed = (await call('liveSubSurfs', body)).includes(sub)
    await call('liveDeleteSubSurf', body, sub)
    const deleted = !(await call('liveSubSurfs', body)).includes(sub)
    const bad = {}
    for (const [op, a, b, value] of [
      ['liveXSecSurfs', 'missing'], ['liveXSecs', 'missing'], ['liveXSecShape', 'missing'],
      ['liveXSecParmIDs', 'missing'], ['liveInsertXSec', body, '2', 999],
      ['liveDeleteXSec', body, '', 999], ['liveChangeXSecShape', 'missing', '2'],
      ['liveSubSurfs', 'missing'], ['liveSubSurfType', 'missing'], ['liveAddSubSurf', 'missing', '1', 0],
      ['liveDeleteSubSurf', body, 'missing'],
    ]) bad[op] = await fails(op, a, b, value)
    const invalidIntegers = []
    for (const text of ['1.5', '1e3', ' 1', '1x', '2147483648', '-2147483649', '']) {
      for (const [op, id] of [['liveInsertXSec', body], ['liveChangeXSecShape', sections[1]], ['liveAddSubSurf', body]]) {
        invalidIntegers.push(await fails(op, id, text, 0))
      }
    }
    for (const value of [1.5, 2147483648, -2147483649]) {
      for (const [op, b] of [['liveInsertXSec', '2'], ['liveDeleteXSec', ''], ['liveAddSubSurf', '1']]) {
        invalidIntegers.push(await fails(op, body, b, value))
      }
    }
    const cleanAfterError = (await call('liveXSecSurfs', body)).length === surfaces.length &&
      (await call('liveXSecs', surfaces[0])).length === before && (await call('liveSubSurfs', body)).length === 0 &&
      (await call('liveXSecShape', sections[1])) === shape
    return { surfaces, sections, shape, parms, before, inserted, restored, listed, sub, subType, wrongOwner, stillListed, deleted, bad, invalidIntegers, cleanAfterError }
  })
  assert.ok(result.surfaces.length && result.sections.length > 2 && result.parms.length)
  assert.equal(typeof result.shape, 'number')
  assert.equal(result.inserted, result.before + 1)
  assert.equal(result.restored, result.before)
  assert.equal(result.subType, 1, 'native GetSubSurfType must report SS_RECTANGLE')
  assert.ok(result.listed.includes(result.sub) && result.wrongOwner && result.stillListed && result.deleted)
  for (const [op, failed] of Object.entries(result.bad)) assert.equal(failed, true, op)
  assert.ok(result.invalidIntegers.every(Boolean), 'malformed or out-of-range integers must be rejected')
  assert.ok(result.cleanAfterError)
  const python = await page.evaluate(async () => {
    const { startConsoleSession } = await import('/src/dualWasmProbe/syncProbe.ts')
    const session = await startConsoleSession()
    try {
      const run = await session.run(`import json
import openvsp as vsp
vsp.ClearVSPModel()
g = vsp.AddGeom('FUSELAGE')
surf = vsp.GetXSecSurf(g, 0)
before = vsp.GetNumXSec(surf)
vsp.InsertXSec(g, 1, vsp.XS_ELLIPSE)
inserted = vsp.GetXSec(surf, 2)
shape = vsp.GetXSecShape(inserted)
sub = vsp.AddSubSurf(g, vsp.SS_RECTANGLE)
failures = []
for fn in (lambda: vsp.GetXSecShape('missing'), lambda: vsp.CutXSec(g, 999), lambda: vsp.DeleteSubSurf(g, 'missing')):
    try:
        fn()
    except vsp.OpenVSPError:
        failures.append(True)
    else:
        failures.append(False)
recovered = vsp.GetNumXSec(surf)
json.dumps(dict(geom=g, sub=sub, shape=shape, ellipse=vsp.XS_ELLIPSE, rectangle=vsp.SS_RECTANGLE, before=before, recovered=recovered, failures=failures))`, true)
      if (!run.ok) throw new Error(run.error)
      const data = JSON.parse(run.value)
      data.nativeSubType = await window.__webvspEngine.testCall('liveSubSurfType', data.sub)
      return data
    } finally { session.close() }
  })
  assert.equal(python.shape, python.ellipse, 'Python-inserted XSec must have XS_ELLIPSE shape')
  assert.equal(python.ellipse, 2)
  assert.equal(python.nativeSubType, python.rectangle, 'Python-created subsurface must have native SS_RECTANGLE type')
  assert.deepEqual(python.failures, [true, true, true], 'native errors must raise OpenVSPError in Python')
  assert.equal(python.recovered, python.before + 1, 'Python bridge must recover after failed calls')
  assert.deepEqual(errors, [])
  console.log('PASS: real WASM XSec/subsurface engine and Python console bridge', JSON.stringify({ bad: result.bad, python }))
} finally { await browser.close() }
