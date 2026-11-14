// Run from web/frontend after `npm run build -- --outDir /absolute/path/to/dist`:
// WEBVSP_TEST_DIST=/absolute/path/to/dist WEBVSP_TEST_CHROMIUM=/path/to/chrome \
//   node src/modeling/production-read-api-check.mjs
// Uses the existing 5179 origin and 5180 WASM server by default; override with
// WEBVSP_TEST_ORIGIN and WEBVSP_TEST_WASM_ORIGIN. It does not start a server.
// Production files are fulfilled from dist, WASM files from the existing server.
// Only a fresh headless Chromium context is used; no user profile or files are opened.
import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'

const dist = process.env.WEBVSP_TEST_DIST
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!dist || !isAbsolute(dist) || !executablePath) throw new Error('Set WEBVSP_TEST_DIST to an absolute build directory and WEBVSP_TEST_CHROMIUM to a Chromium executable')
const root = resolve(dist)
const origin = new URL(process.env.WEBVSP_TEST_ORIGIN ?? 'http://127.0.0.1:5179').origin
const wasmOrigin = new URL(process.env.WEBVSP_TEST_WASM_ORIGIN ?? 'http://127.0.0.1:5180').origin
for (const value of [origin, wasmOrigin]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw new Error('Test origins must be loopback addresses')
}
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' })
const paths = [], failures = [], errors = []
try {
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`))
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    paths.push(url.pathname)
    if (url.origin !== origin) return route.abort()
    if (url.pathname.startsWith('/wasm/')) {
      const response = await route.fetch({ url: `${wasmOrigin}${url.pathname}${url.search}`, timeout: 120000 })
      return route.fulfill({ response, headers: { ...response.headers(), 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    if (!path.startsWith(root + sep)) return route.abort()
    try {
      const body = await readFile(path)
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream'
      return route.fulfill({ status: 200, body, headers: { 'content-type': type, 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' } })
    } catch { return route.abort() }
  })
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  try { await page.waitForSelector('[data-ready="1"]', { timeout: 120000 }) }
  catch (error) {
    console.error(JSON.stringify({ paths, failures, errors, text: (await page.locator('body').innerText()).slice(0, 1500) }, null, 2))
    throw error
  }
  const result = await page.evaluate(async () => {
    const api = window.__webvspModelingReadV1
    if (!api) throw new Error('Missing production entry')
    const info = await api.model.getInfo(), again = await api.model.getInfo(), list = await api.geometry.list(info.identity), types = await api.geometry.listTypes(info.identity)
    const pending = [api.capabilities(), api.protocol(), api.declaredCapabilities()]
    const promises = pending.map(value => value instanceof Promise)
    const [capabilities, protocol, declared] = await Promise.all(pending)
    const snapshots = structuredClone({ capabilities, protocol, declared })
    // Mutating returned objects must not affect later calls or other results.
    capabilities.features[0].status = 'modified'
    protocol.operations.push('modified')
    declared[0].missingOperations.push('modified')
    const [capabilitiesAgain, protocolAgain, declaredAgain] = await Promise.all([api.capabilities(), api.protocol(), api.declaredCapabilities()])
    const afterDeclarations = await api.model.getInfo()
    return {
      isolated: crossOriginIsolated, sameEntry: api === window.__webvspModelingReadV1, info, again, list, types,
      promises, snapshots, capabilitiesAgain, protocolAgain, declaredAgain, afterDeclarations,
      top: Object.keys(api).sort(),
      keys: Object.fromEntries(['model', 'geometry', 'parameter', 'wing', 'fuselage'].map(k => [k, Object.keys(api[k]).sort()])),
    }
  })
  assert.equal(result.isolated, true)
  assert.equal(result.sameEntry, true)
  assert.deepEqual(result.info, result.again)
  assert.equal(result.info.geometries.length, 0, 'Expected an empty disposable model')
  assert.deepEqual(result.list.geometries ?? result.list, result.info.geometries)
  assert.ok(Array.isArray(result.types) && result.types.includes('FUSELAGE') && result.types.includes('WING'))
  const names = ['model.read', 'geometry.read', 'geometry.create', 'geometry.move', 'parameter.read', 'parameter.write', 'wing.read', 'wing.edit', 'fuselage.read', 'fuselage.edit', 'assembly.attach']
  const reads = new Set(['model.read', 'geometry.read', 'parameter.read', 'wing.read', 'fuselage.read'])
  const supported = new Set([...reads, 'geometry.create', 'geometry.move', 'parameter.write'])
  const capabilities = { contractVersion: '0.1', features: names.map(name => supported.has(name)
    ? { name, status: 'supported' }
    : { name, status: 'unsupported', reason: 'Not implemented or not verified' }) }
  const protocol = { status: 'valid', operations: [
    'modelDiscovery', 'model', 'geomTypes', 'bbox', 'origin', 'geomXSecs', 'fuselageXSecShapes',
    'wingXSecShapes', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm',
    'fuselageLength', 'guardedEpochV1',
  ] }
  // This checks the declaration contract only, not actual support, readiness, safety or authorization.
  const declared = names.map(name => reads.has(name)
    ? { name, status: 'declared', missingOperations: [] }
    : { name, status: 'unknown', missingOperations: null })
  assert.deepEqual(result.promises, [true, true, true], 'production entry returns promises')
  assert.deepEqual(result.snapshots, { capabilities, protocol, declared }, 'exact production declaration contracts')
  assert.deepEqual(result.capabilitiesAgain, capabilities, 'capabilities are fresh and unchanged')
  assert.deepEqual(result.protocolAgain, protocol, 'protocol is fresh and unchanged')
  assert.deepEqual(result.declaredAgain, declared, 'declared capabilities are fresh and unchanged')
  assert.deepEqual(result.afterDeclarations, result.info, 'declaration calls must not change the model')
  assert.deepEqual(result.top, ['capabilities', 'declaredCapabilities', 'describeSurface', 'fuselage', 'geometry', 'model', 'parameter', 'protocol', 'wing'])
  assert.deepEqual(result.keys, {
    model: ['getInfo', 'getSelection', 'getVisibleSurfaceBounds'], geometry: ['get', 'list', 'listTypes'],
    parameter: ['getCrossSectionParameter', 'getFuselageLength', 'getGeometryParameter', 'listCrossSectionParameterIds', 'listGeometryParameterIds', 'listSurfaces'],
    wing: ['get', 'getSectionDimensions'], fuselage: ['get'],
  })
  // Create the fixture only through the mirrored GUI, in this disposable context.
  const select = page.locator('select').filter({ has: page.locator('option:text-is("FUSELAGE")') }).first()
  for (const [type, count] of [['FUSELAGE', 1], ['WING', 2]]) {
    await select.selectOption({ label: type })
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    await page.waitForFunction(n => window.__webvspModelingReadV1.model.getInfo().then(info => info.geometries.length === n), count, { timeout: 30000 })
  }
  const populated = await page.evaluate(async () => {
    const api = window.__webvspModelingReadV1
    const info = await api.model.getInfo(), identity = info.identity
    const fuselage = info.geometries.find(g => g.type.toUpperCase() === 'FUSELAGE')
    const wing = info.geometries.find(g => g.type.toUpperCase() === 'WING')
    if (!fuselage || !wing) throw new Error('Missing GUI fixture geometry')
    const list = await api.geometry.list(identity)
    const geometry = await api.geometry.get(fuselage.id, identity)
    const selection = await api.model.getSelection(identity)
    const bounds = await api.model.getVisibleSurfaceBounds(identity)
    const surfaces = await api.parameter.listSurfaces(fuselage.id, identity)
    const wingSurfaces = await api.parameter.listSurfaces(wing.id, identity)
    const length = await api.parameter.getFuselageLength(fuselage.id, identity)
    const geometryIds = await api.parameter.listGeometryParameterIds(fuselage.id, identity)
    const geometryParameter = await api.parameter.getGeometryParameter(fuselage.id, length.id, identity)
    let sectionId, sectionIds
    for (const section of surfaces.flatMap(s => s.xsecs)) {
      const ids = await api.parameter.listCrossSectionParameterIds(section, identity)
      if (ids.length) { sectionId = section; sectionIds = ids; break }
    }
    if (!sectionId) throw new Error('Fixture has no cross-section parameters')
    const sectionParameter = await api.parameter.getCrossSectionParameter(sectionId, sectionIds[0], identity)
    return { info, fuselage, wing, list, geometry, selection, bounds, surfaces, wingSurfaces, length, geometryIds, geometryParameter, sectionId, sectionIds, sectionParameter,
      fuselageView: await api.fuselage.get(fuselage.id, identity), wingView: await api.wing.get(wing.id, identity) }
  })
  assert.deepEqual(populated.list.geometries, populated.info.geometries)
  assert.deepEqual(populated.geometry.geometry, populated.fuselage)
  assert.deepEqual(populated.selection.geometryIds, populated.info.selectedGeometryIds)
  assert.ok(populated.bounds && ['min', 'max'].every(k => populated.bounds[k].length === 3 && populated.bounds[k].every(Number.isFinite)))
  assert.ok(populated.geometryIds.includes(populated.length.id))
  assert.deepEqual(populated.geometryParameter, populated.length)
  assert.equal(populated.length.name, 'Length')
  assert.equal(populated.length.group, 'Design')
  assert.equal(populated.length.container, populated.fuselage.id)
  assert.equal(populated.sectionParameter.id, populated.sectionIds[0])
  assert.equal(populated.fuselageView.geometry.id, populated.fuselage.id)
  assert.deepEqual(populated.fuselageView.length, populated.length)
  assert.ok(populated.surfaces.length && populated.surfaces.some(s => s.xsecs.length))
  assert.ok(populated.wingSurfaces.length && populated.wingSurfaces.some(s => s.xsecs.length))
  for (const [view, raw, sectionKey] of [[populated.fuselageView.surfaces, populated.surfaces, 'sections'], [populated.wingView.surfaces, populated.wingSurfaces, 'stations']]) {
    assert.equal(view.length, raw.length)
    for (let i = 0; i < raw.length; i++) {
      assert.equal(view[i].id, raw[i].id)
      assert.deepEqual(view[i][sectionKey].map(s => s.id), raw[i].xsecs)
      for (const [index, section] of view[i][sectionKey].entries()) {
        assert.equal(section.index, index)
        assert.ok(Number.isInteger(section.shape) && section.shape !== -1)
        if (sectionKey === 'stations') assert.equal(section.kind, index === 0 ? 'rootAirfoilStation' : 'wingSection')
      }
    }
  }
  assert.equal(populated.wingView.geometryId, populated.wing.id)
  // OpenVSP's default native curve codes: POINT/ELLIPSE and FOUR_SERIES.
  assert.deepEqual(populated.fuselageView.surfaces.map(s => s.sections.map(x => x.shape)), [[0, 2, 2, 2, 0]])
  assert.deepEqual(populated.wingView.surfaces.map(s => s.stations.map(x => x.shape)), [[7, 7]])

  await page.locator('.m-menubar').getByRole('button', { name: 'File', exact: true }).click()
  await page.locator('.menu-list').getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click()
  await page.waitForFunction(epoch => window.__webvspModelingReadV1.model.getInfo().then(info => info.identity.modelEpoch !== epoch), populated.info.identity.modelEpoch, { timeout: 30000 })
  const after = await page.evaluate(async ({ identity, fuselage, wing, length, sectionId, sectionParameter }) => {
    const api = window.__webvspModelingReadV1
    const calls = {
      info: () => api.model.getInfo(identity), selection: () => api.model.getSelection(identity), bounds: () => api.model.getVisibleSurfaceBounds(identity), list: () => api.geometry.list(identity),
      types: () => api.geometry.listTypes(identity), geometry: () => api.geometry.get(fuselage.id, identity),
      surfaces: () => api.parameter.listSurfaces(fuselage.id, identity),
      length: () => api.parameter.getFuselageLength(fuselage.id, identity),
      geometryIds: () => api.parameter.listGeometryParameterIds(fuselage.id, identity),
      sectionIds: () => api.parameter.listCrossSectionParameterIds(sectionId, identity),
      geometryParameter: () => api.parameter.getGeometryParameter(fuselage.id, length.id, identity),
      sectionParameter: () => api.parameter.getCrossSectionParameter(sectionId, sectionParameter.id, identity),
      fuselage: () => api.fuselage.get(fuselage.id, identity), wing: () => api.wing.get(wing.id, identity),
    }
    const stale = {}
    for (const [name, call] of Object.entries(calls)) {
      try { await call(); stale[name] = 'SUCCEEDED' } catch (error) { stale[name] = error.code ?? String(error) }
    }
    return { stale, info: await api.model.getInfo() }
  }, { identity: populated.info.identity, fuselage: populated.fuselage, wing: populated.wing, length: populated.length, sectionId: populated.sectionId, sectionParameter: populated.sectionParameter })
  assert.equal(after.info.geometries.length, 0)
  for (const [name, code] of Object.entries(after.stale)) assert.equal(code, 'STALE_MODEL', `${name} must reject stale epoch`)
  assert.ok(paths.some(p => p === '/wasm/vsp.js'))
  assert.equal(paths.filter(p => p === '/wasm/vsp.wasm').length, 1)
  assert.ok(paths.some(p => /^\/assets\/index-.*\.js$/.test(p)))
  assert.ok(!paths.some(p => p.startsWith('/src/') || p.startsWith('/@vite/')))
  assert.deepEqual(errors, [])
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ pass: true, paths, session: result.info.identity, geometryCount: result.info.geometries.length, keys: result.keys }, null, 2))
} finally {
  await context.close()
  await browser.close()
}
