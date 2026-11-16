// Geometry hierarchy and rename over the live engine.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/geometry-browser-check.mjs
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const failures = []
try {
  const page = await browser.newPage()
  const errors = [], external = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  const url = new URL(base)
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__runPython === 'function')

  const r = await page.evaluate(() => window.__runPython(`
import json, openvsp as vsp
w = vsp.AddGeom('WING')
pod = vsp.AddGeom('POD', w)
clone = vsp.AddGeom('CLONE', w)
vsp.Update()
out = {}
out['ids'] = vsp.FindGeoms()
out['name'] = vsp.GetGeomName(w)
out['type'] = vsp.GetGeomTypeName(w)
out['wingParent'] = vsp.GetGeomParent(w)
out['podParent'] = vsp.GetGeomParent(pod)
out['wingChildren'] = vsp.GetGeomChildren(w)
out['leafChildren'] = vsp.GetGeomChildren(pod)
vsp.SetGeomName(w, 'MainWing')
out['renamed'] = vsp.GetGeomName(w)
out['found'] = vsp.FindGeom('MainWing', 0)
out['childrenStill'] = vsp.GetGeomChildren(w)
try:
    vsp.SetGeomName(clone, 'NotAllowed')
    out['cloneRename'] = 'no error'
except Exception as exc:
    out['cloneRename'] = type(exc).__name__
try:
    vsp.SetGeomName('no-such-id', 'X')
    out['missingRename'] = 'no error'
except Exception as exc:
    out['missingRename'] = type(exc).__name__
json.dumps(out)
`))
  const v = typeof r === 'string' ? JSON.parse(r) : r
  if (!v.ids.includes(v.podParent)) failures.push(`parent id not in model: ${JSON.stringify(v)}`)
  if (v.wingParent !== 'NONE') failures.push(`top-level parent should be NONE: ${JSON.stringify(v.wingParent)}`)
  if (v.podParent !== v.found && !v.ids.includes(v.podParent)) failures.push(`POD parent: ${JSON.stringify(v)}`)
  if (!Array.isArray(v.wingChildren) || v.wingChildren.length < 2) failures.push(`wing children: ${JSON.stringify(v)}`)
  if (!Array.isArray(v.leafChildren) || v.leafChildren.length !== 0) failures.push(`leaf children: ${JSON.stringify(v)}`)
  if (v.renamed !== 'MainWing') failures.push(`rename not visible immediately: ${JSON.stringify(v)}`)
  if (!v.ids.includes(v.found)) failures.push(`FindGeom after rename: ${JSON.stringify(v)}`)
  if (!Array.isArray(v.childrenStill) || v.childrenStill.length < 2) failures.push(`children lost after rename: ${JSON.stringify(v)}`)
  if (v.cloneRename !== 'OpenVSPError') failures.push(`auto-named clone should refuse rename: ${JSON.stringify(v)}`)
  if (v.missingRename !== 'OpenVSPError') failures.push(`missing geometry rename: ${JSON.stringify(v)}`)
  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS geometry hierarchy + rename')
} finally { await browser.close() }
