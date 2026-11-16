// Parameter metadata and SetParmValUpdate over the live engine.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/params-browser-check.mjs
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
vsp.SetParmVal(w, 'TotalSpan', 'WingGeom', 12.0)
vsp.Update()
pid = vsp.FindParm(w, 'TotalSpan', 'WingGeom')
info = vsp.GetParmInfo(pid)
out = {
  'pid': pid,
  'type': vsp.GetParmType(pid),
  'doubleType': vsp.PARM_DOUBLE_TYPE,
  'lower': vsp.GetParmLowerLimit(pid),
  'upper': vsp.GetParmUpperLimit(pid),
  'active': vsp.GetParmActiveFlag(pid),
  'valueById': vsp.GetParmVal(pid),
  'name': vsp.GetParmName(pid),
  'group': vsp.GetParmGroupName(pid),
  'displayGroup': vsp.GetParmDisplayGroupName(pid),
  'infoLower': info.get('lower'),
  'infoUpper': info.get('upper'),
  'infoActive': info.get('active'),
  'infoGroupName': info.get('groupName'),
  'findByName': vsp.FindParm(w, 'NoSuchParm', 'WingGeom'),
}
vsp.SetParmValUpdate(pid, 14.0)
out['afterId'] = vsp.GetParmVal(pid)
vsp.SetParmValUpdate(w, 'TotalSpan', 'WingGeom', 16.0)
out['afterName'] = vsp.GetParmVal(w, 'TotalSpan', 'WingGeom')
try:
    vsp.GetParmType('no-such-parm')
except Exception as exc:
    out['missingType'] = type(exc).__name__
json.dumps(out)
`))
  const v = typeof r === 'string' ? JSON.parse(r) : r
  if (!v.pid) failures.push(`FindParm returned no ID: ${JSON.stringify(v)}`)
  if (v.type !== v.doubleType) failures.push(`GetParmType: ${JSON.stringify(v)}`)
  if (!(typeof v.lower === 'number' && typeof v.upper === 'number' && v.lower < v.upper)) failures.push(`limits: ${JSON.stringify(v)}`)
  if (v.active !== true) failures.push(`active flag: ${JSON.stringify(v)}`)
  if (Math.abs(v.valueById - 12) > 1e-9) failures.push(`GetParmVal(parm_id): ${JSON.stringify(v)}`)
  if (v.name !== 'TotalSpan') failures.push(`GetParmName: ${JSON.stringify(v)}`)
  if (v.group !== 'WingGeom') failures.push(`GetParmGroupName: ${JSON.stringify(v)}`)
  if (!v.displayGroup) failures.push(`GetParmDisplayGroupName: ${JSON.stringify(v)}`)
  if (v.infoLower !== v.lower || v.infoUpper !== v.upper || v.infoActive !== true) failures.push(`GetParmInfo fields: ${JSON.stringify(v)}`)
  if (!v.infoGroupName) failures.push(`GetParmInfo groupName: ${JSON.stringify(v)}`)
  if (v.findByName !== '') failures.push(`missing FindParm should be '': ${JSON.stringify(v)}`)
  if (Math.abs(v.afterId - 14) > 1e-9) failures.push(`SetParmValUpdate(parm_id): ${JSON.stringify(v)}`)
  if (Math.abs(v.afterName - 16) > 1e-9) failures.push(`SetParmValUpdate(geom,name,group): ${JSON.stringify(v)}`)
  if (v.missingType !== 'OpenVSPError') failures.push(`missing parm type error: ${JSON.stringify(v)}`)

  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS parameter metadata + SetParmValUpdate')
} finally { await browser.close() }
