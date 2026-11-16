// CompGeom over the live engine, including its native model side effects.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/compgeom-browser-check.mjs
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
out = {}
w = vsp.AddGeom('WING')
vsp.SetParmVal(w, 'TotalSpan', 'WingGeom', 12.0)
vsp.Update()
out['before'] = vsp.FindGeoms()
vsp.SetAnalysisInputDefaults('CompGeom')
vsp.SetIntAnalysisInput('CompGeom', 'Set', [vsp.SET_ALL])
root = vsp.ExecAnalysis('CompGeom')
out['root'] = root
out['name'] = vsp.GetResultsName(root)
out['fields'] = vsp.GetAllDataNames(root)
out['wetArea'] = [float(x) for x in vsp.GetDoubleResults(root, 'Total_Wet_Area')]
out['wetVol'] = [float(x) for x in vsp.GetDoubleResults(root, 'Total_Wet_Vol')]
out['after'] = vsp.FindGeoms()
out['types'] = [vsp.GetGeomTypeName(g) for g in out['after']]
out['wingShown'] = vsp.GetSetFlag(w, vsp.SET_SHOWN)
mesh = [g for g in out['after'] if vsp.GetGeomTypeName(g) == 'Mesh']
out['meshId'] = mesh[0] if mesh else None
if out['meshId']:
    vsp.DeleteGeom(out['meshId'])
vsp.SetSetFlag(w, vsp.SET_SHOWN, True)
out['cleaned'] = vsp.FindGeoms()
out['wingShownAfter'] = vsp.GetSetFlag(w, vsp.SET_SHOWN)
json.dumps(out)
`))
  const v = typeof r === 'string' ? JSON.parse(r) : r
  if (v.name !== 'Comp_Geom') failures.push(`CompGeom result name: ${JSON.stringify(v.name)}`)
  for (const field of ['Total_Wet_Area', 'Total_Wet_Vol', 'Num_Comps']) {
    if (!v.fields.includes(field)) failures.push(`CompGeom missing ${field}: ${JSON.stringify(v.fields)}`)
  }
  if (!(v.wetArea.length === 1 && Number.isFinite(v.wetArea[0]) && v.wetArea[0] > 0)) failures.push(`Total_Wet_Area: ${JSON.stringify(v.wetArea)}`)
  if (!(v.wetVol.length === 1 && Number.isFinite(v.wetVol[0]) && v.wetVol[0] > 0)) failures.push(`Total_Wet_Vol: ${JSON.stringify(v.wetVol)}`)
  if (!v.types.includes('Mesh')) failures.push(`CompGeom did not add its Mesh geom: ${JSON.stringify(v)}`)
  if (v.wingShown !== false) failures.push(`CompGeom should hide other geoms (native): ${JSON.stringify(v.wingShown)}`)
  if (!Array.isArray(v.cleaned) || v.cleaned.length !== 1) failures.push(`cleanup did not remove the mesh: ${JSON.stringify(v.cleaned)}`)
  if (v.wingShownAfter !== true) failures.push(`cleanup did not restore visibility: ${JSON.stringify(v.wingShownAfter)}`)
  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS CompGeom results and native side effects')
} finally { await browser.close() }
