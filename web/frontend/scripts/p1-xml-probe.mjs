// Phase 1 spike: measure Vehicle::EncodeXml side effects on a real page model.
// Needs the DEV server (testCall/testCallGuarded are DEV-only):
//   npm run dev -- --host 127.0.0.1 --port 5173
//   WEBVSP_URL=http://127.0.0.1:5173/ node scripts/p1-xml-probe.mjs
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:5173/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const url = new URL(base)
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })

  const report = await page.evaluate(async () => {
    const engine = window.__webvspEngine
    if (typeof engine.testCallGuarded !== 'function') throw new Error('DEV-only testCallGuarded is unavailable; run the Vite dev server')

    const wing = await engine.request('POST', '/geoms', { type: 'WING' })
    const pod = await engine.request('POST', '/geoms', { type: 'POD' })
    const prop = await engine.request('POST', '/geoms', { type: 'PROP' })
    const parmIds = await engine.testCall('geomParmIDs', wing.id)
    const ids = Array.isArray(parmIds) ? parmIds.map(p => typeof p === 'string' ? p : p.id) : []
    const parms = await Promise.all(ids.slice(0, 400).map(async id => ({ id, name: (await engine.testCall('geomParm', wing.id, id))?.name })))
    const span = parms.find(p => p.name === 'Span')
    const total = parms.find(p => p.name === 'TotalSpan')
    let changed = []
    const model0 = await engine.request('GET', '/model')
    if (span) await engine.testCallGuarded('geomSetParm', wing.id, span.id, 12, model0.modelEpoch)
    if (total) await engine.testCallGuarded('geomSetParm', wing.id, total.id, 12, model0.modelEpoch)
    await engine.testCallGuarded('guardedSetGeomName', wing.id, 'MainWing', 0, model0.modelEpoch)
    await engine.request('POST', '/geoms/duplicate', { ids: [pod.id] }).catch(() => null)

    const modelBefore = await engine.request('GET', '/model')
    const probe = await engine.testCallGuarded('p1XmlProbe', 'xml', '', 0, modelBefore.modelEpoch)
    // Watcher runs between jobs; a later read shows whether it emitted.
    await new Promise(r => setTimeout(r, 600))
    const modelAfter = await engine.request('GET', '/model')

    const treeBefore = modelBefore.geoms.map(g => [g.id, g.name, g.type, g.numXSecSurfs])
    const treeAfter = modelAfter.geoms.map(g => [g.id, g.name, g.type, g.numXSecSurfs])
    return {
      probe,
      revBefore: modelBefore.rev,
      revAfter: modelAfter.rev,
      watcherEmitted: modelAfter.rev !== modelBefore.rev,
      dirtyBefore: modelBefore.dirty,
      dirtyAfter: modelAfter.dirty,
      fileNameBefore: modelBefore.fileName,
      fileNameAfter: modelAfter.fileName,
      activeBefore: modelBefore.active,
      activeAfter: modelAfter.active,
      treeEqual: JSON.stringify(treeBefore) === JSON.stringify(treeAfter),
      geoms: treeBefore.length,
      changed,
    }
  })
  console.log(JSON.stringify({ ...report, pageErrors: errors }, null, 2))
  if (errors.length) process.exitCode = 1
} finally { await browser.close() }
