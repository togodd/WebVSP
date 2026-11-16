// MassProp and the analysis/set discovery APIs over the live engine.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/analysis-browser-check.mjs
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
import json, math, openvsp as vsp
out = {}
out['analyses'] = vsp.ListAnalysis()
out['inputs'] = vsp.GetAnalysisInputNames('MassProp')
out['setType'] = vsp.GetAnalysisInputType('MassProp', 'Set')
out['missingType'] = vsp.GetAnalysisInputType('MassProp', 'NoSuchInput')

w = vsp.AddGeom('WING')
vsp.SetParmVal(w, 'TotalSpan', 'WingGeom', 12.0)
vsp.Update()
out['setIndex'] = vsp.GetSetIndex('All')
out['geomSet'] = vsp.GetGeomSet('All')
out['geomSetAt'] = vsp.GetGeomSetAtIndex(out['setIndex']) if out['setIndex'] >= 0 else None

vsp.SetAnalysisInputDefaults('MassProp')
vsp.SetIntAnalysisInput('MassProp', 'Set', [vsp.SET_ALL])
vsp.SetIntAnalysisInput('MassProp', 'NumMassSlices', [10])
root = vsp.ExecAnalysis('MassProp')
out['root'] = root
out['resultName'] = vsp.GetResultsName(root)
out['fields'] = vsp.GetAllDataNames(root)
mass = vsp.GetDoubleResults(root, 'Total_Mass')
cg = vsp.GetVec3dResults(root, 'Total_CG')
out['mass'] = [float(x) for x in mass]
out['cg'] = [[p.x(), p.y(), p.z()] for p in cg]

vsp.SetAnalysisInputDefaults('DegenGeom')
degen = vsp.ExecAnalysis('DegenGeom')
out['degenName'] = vsp.GetResultsName(degen)
try:
    vsp.SetIntAnalysisInput('MassProp', 'BogusInput', [1])
    out['bogus'] = 'no error'
except Exception as exc:
    out['bogus'] = type(exc).__name__
json.dumps(out)
`))
  const v = typeof r === 'string' ? JSON.parse(r) : r
  for (const name of ['MassProp', 'DegenGeom', 'SurfacePatches']) {
    if (!v.analyses.includes(name)) failures.push(`ListAnalysis missing ${name}`)
  }
  if (!v.inputs.includes('Set') || !v.inputs.includes('NumMassSlices')) failures.push(`MassProp inputs: ${JSON.stringify(v.inputs)}`)
  if (v.setType !== 1) failures.push(`GetAnalysisInputType(Set): ${JSON.stringify(v.setType)}`)
  if (v.missingType !== -1) failures.push(`unknown input type should be -1: ${JSON.stringify(v.missingType)}`)
  if (!(v.setIndex >= 0)) failures.push(`GetSetIndex('All'): ${JSON.stringify(v.setIndex)}`)
  if (!Array.isArray(v.geomSet) || v.geomSet.length !== 1) failures.push(`GetGeomSet('All'): ${JSON.stringify(v.geomSet)}`)
  if (!Array.isArray(v.geomSetAt) || v.geomSetAt[0] !== v.geomSet[0]) failures.push(`GetGeomSetAtIndex: ${JSON.stringify(v)}`)
  if (v.resultName !== 'Mass_Properties') failures.push(`MassProp result name: ${JSON.stringify(v.resultName)}`)
  if (!v.fields.includes('Total_Mass') || !v.fields.includes('Total_CG')) failures.push(`MassProp fields: ${JSON.stringify(v.fields)}`)
  if (!(Array.isArray(v.mass) && v.mass.length === 1 && Number.isFinite(v.mass[0]) && v.mass[0] > 0)) failures.push(`Total_Mass: ${JSON.stringify(v.mass)}`)
  if (!(Array.isArray(v.cg) && v.cg.length === 1 && v.cg[0].every(Number.isFinite))) failures.push(`Total_CG: ${JSON.stringify(v.cg)}`)
  if (v.degenName !== 'DegenGeom') failures.push(`DegenGeom regression: ${JSON.stringify(v.degenName)}`)
  if (v.bogus !== 'OpenVSPError') failures.push(`unknown analysis input should fail: ${JSON.stringify(v.bogus)}`)
  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS analysis discovery + MassProp')
} finally { await browser.close() }
