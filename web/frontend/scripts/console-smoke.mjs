// Python console smoke: persistent session, XSec/subsurf/set APIs, live analysis.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/console-smoke.mjs
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const failures = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(new URL(base).href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.click('[data-testid="console-open"]')
  await page.waitForSelector('[data-testid="console-window"]')

  const run = async (code) => {
    await page.fill('[data-testid="console-input"]', code)
    await page.click('[data-testid="console-run"]')
    await page.waitForFunction(() => !document.querySelector('[data-testid="console-run"]')?.textContent?.includes('…'), null, { timeout: 180_000 })
    const entries = await page.$$eval('[data-testid="console-output"] .py-console-entry', els => els.map(el => ({
      value: el.querySelector('.py-console-value')?.textContent ?? '',
      error: el.querySelector('.py-console-error')?.textContent ?? '',
      stdout: el.querySelector('.py-console-stdout')?.textContent ?? '',
    })))
    return entries[entries.length - 1]
  }

  // Session 1: build a wing and read it back in a later run (persistent state).
  let r = await run('import openvsp as vsp\nw = vsp.AddGeom("WING")\nw')
  if (r.error) failures.push(`first run failed: ${r.error}`)
  r = await run('len(vsp.FindGeoms()), vsp.GetGeomName(w), vsp.GetGeomTypeName(w)')
  if (r.error || !r.value.includes('1') || !r.value.includes('Wing')) failures.push(`session not persistent: ${JSON.stringify(r)}`)

  // Canonical and historical upstream imports must be identical in the real worker.
  r = await run('import openvsp.surface_patches as sp, surface_patches\nimport openvsp.degen_geom_parse as dp, degen_geom_parse\nimport openvsp.utilities as ou, openvsp_utilities\nimport utilities.uberlogging as ul\n(sp is surface_patches, dp is degen_geom_parse, ou is openvsp_utilities, ul.StyleAdapter.__name__)')
  if (r.error || r.value.trim() !== "(True, True, True, 'StyleAdapter')") failures.push(`package imports failed: ${JSON.stringify(r)}`)

  // Original utility uses the worker's virtual filesystem, never host files.
  r = await run(`import tempfile, pathlib
import utilities.wt_util as wt
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    (root / 'a.txt').write_text('alpha\\n')
    (root / 'b.txt').write_text('beta\\n')
    wt.merge_files([str(root / 'a.txt'), str(root / 'b.txt')], str(root / 'merged'))
    assert (root / 'merged').read_text() == 'alpha\\nbeta\\n'
    assert pathlib.Path(wt.archive_file(str(root / 'merged'), 'v1')).read_text() == 'alpha\\nbeta\\n'
    wt.archive(str(root), 'v2')
    assert (root / 'v2' / 'ver').read_text() == 'v2'
    wt.remove_files(str(root / '*.txt'))
    wt.remove_file(str(root / 'merged'))
    assert not (root / 'a.txt').exists() and not (root / 'merged').exists()
int(wt.find_nearest([0, 2, 4], 3.9))`)
  if (r.error || r.value.trim() !== '2') failures.push(`wt_util virtual filesystem failed: ${JSON.stringify(r)}`)

  // XSec API.
  r = await run('s = vsp.GetXSecSurfIDs(w)[0]\nxs = vsp.GetXSecIDs(s)\nlen(xs), [vsp.GetXSecShape(i) for i in xs]')
  if (r.error || !r.value.includes('2')) failures.push(`XSec read failed: ${JSON.stringify(r)}`)
  r = await run('vsp.InsertXSec(w, 1, vsp.XS_FOUR_SERIES)\nvsp.Update()\nvsp.GetNumXSec(vsp.GetXSecSurfIDs(w)[0])')
  if (r.error || r.value.trim() !== '3') failures.push(`InsertXSec failed: ${JSON.stringify(r)}`)
  r = await run('vsp.CutXSec(w, 1)\nvsp.Update()\nvsp.GetNumXSec(vsp.GetXSecSurfIDs(w)[0])')
  if (r.error || r.value.trim() !== '2') failures.push(`CutXSec failed: ${JSON.stringify(r)}`)

  // Subsurface API: add a control surface, then read the parameter of it.
  r = await run('ss = vsp.AddSubSurf(w, vsp.SS_CONTROL, 0)\nlen(vsp.GetSubSurfIDVec(w)), ss != ""')
  if (r.error || !r.value.includes('1') || !r.value.includes('True')) failures.push(`AddSubSurf failed: ${JSON.stringify(r)}`)
  r = await run('ids = vsp.GetGeomParmIDs(w)\n[ (p["group"], p["name"]) for p in map(vsp.GetParmInfo, ids) if "SS_" in p["group"] ][:3]')
  if (r.error || !r.value.includes('SS_')) failures.push(`subsurface parms missing: ${JSON.stringify(r)}`)

  // Sets.
  r = await run('n = vsp.GetNumSets()\n(n, vsp.GetSetName(0), vsp.GetSetFlag(w, 0))')
  if (r.error || !r.value.includes('All')) failures.push(`sets failed: ${JSON.stringify(r)}`)

  // Parameter by ID + analysis on the live model, parsed by the original helper.
  r = await run(`import openvsp as vsp, degen_geom_parse
pid = vsp.GetParmInfoByName(w, "TotalSpan", "WingGeom")["id"]
vsp.SetParmValByID(pid, 15.0)
vsp.Update()
vsp.SetAnalysisInputDefaults("DegenGeom")
vsp.SetIntAnalysisInput("DegenGeom", "Set", [vsp.SET_ALL])
root = vsp.ExecAnalysis("DegenGeom")
(vsp.GetParmValByID(pid), len(degen_geom_parse.parse_degen_geom(root)))`)
  if (r.error || !/^\(15(?:\.0)?, 2\)$/.test(r.value.trim())) failures.push(`analysis failed: ${JSON.stringify(r)}`)

  // stdout capture and error reporting.
  r = await run('print("hello console")\n1 + 1')
  if (r.error || !r.stdout.includes('hello console') || !r.value.includes('2')) failures.push(`stdout capture failed: ${JSON.stringify(r)}`)
  r = await run('1/0')
  if (!r.error.includes('ZeroDivisionError')) failures.push(`error not reported: ${JSON.stringify(r)}`)
  r = await run('"session alive"')
  if (r.error || !r.value.includes('session alive')) failures.push(`session died after error: ${JSON.stringify(r)}`)

  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS python console: persistent session, XSec, subsurface, sets, analysis, stdout, errors')
} finally { await browser.close() }
