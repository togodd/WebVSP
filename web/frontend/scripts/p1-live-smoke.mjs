// In-process mode: user Python calling the live page model, as on desktop.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/p1-live-smoke.mjs
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4173/'
const script = String.raw`
import json
import openvsp as vsp
import degen_geom_parse

wing = vsp.AddGeom("WING")
vsp.SetParmVal(wing, "TotalSpan", "WingGeom", 12.0)
vsp.Update()

before = vsp.GetParmVal(wing, "TotalSpan", "WingGeom")
vsp.SetAnalysisInputDefaults("DegenGeom")
vsp.SetIntAnalysisInput("DegenGeom", "Set", [vsp.SET_ALL])
root = vsp.ExecAnalysis("DegenGeom")

names = vsp.GetAllDataNames(root)
objects = degen_geom_parse.parse_degen_geom(root)
patches_root = vsp.ExecAnalysis("SurfacePatches")

json.dumps({
    "wing": wing,
    "span": before,
    "spanAfter": vsp.GetParmVal(wing, "TotalSpan", "WingGeom"),
    "root": root,
    "resultName": vsp.GetResultsName(root),
    "fields": names,
    "objectCount": len(objects),
    "objectTypes": [o.type.name for o in objects],
    "firstGeom": objects[0].geom_id if objects else None,
    "degenIds": vsp.GetStringResults(root, "Degen_DegenGeoms"),
    "patchRoot": patches_root,
    "patchFields": vsp.GetAllDataNames(patches_root),
    "allResults": len(vsp.GetAllResultsIDs()),
})
`

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const failures = []
try {
  const page = await browser.newPage()
  const errors = [], external = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  const url = new URL(base)
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__runPython === 'function')

  const before = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  const started = Date.now()
  const result = await page.evaluate((code) => window.__runPython(code), script)
  const duration = Date.now() - started
  const after = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))

  const r = typeof result === 'string' ? JSON.parse(result) : result
  if (!r?.wing) failures.push(`no wing created: ${JSON.stringify(result).slice(0, 400)}`)
  if (Math.abs(r.span - 12) > 1e-9) failures.push(`span write wrong: ${r.span}`)
  if (Math.abs(r.spanAfter - 12) > 1e-9) failures.push(`span readback wrong: ${r.spanAfter}`)
  if (!r.root || r.root === r.patchRoot) failures.push(`bad analysis roots: ${r.root} / ${r.patchRoot}`)
  if (!Array.isArray(r.objectCount ? [r.objectCount] : null) || r.objectCount < 1) failures.push(`no degen objects: ${r.objectCount}`)
  if (!r.degenIds?.length) failures.push(`no nested degen ids`)
  if (!r.fields?.includes('Degen_DegenGeoms')) failures.push(`missing root field: ${JSON.stringify(r.fields)}`)
  if (!r.patchFields?.includes('components')) failures.push(`missing patch field: ${JSON.stringify(r.patchFields)}`)
  if (!(r.allResults >= 2)) failures.push(`results not retained: ${r.allResults}`)

  const newGeoms = after.geoms.length - before.geoms.length
  if (newGeoms !== 1) failures.push(`expected one new geom on the page model, got ${newGeoms}`)
  console.log(JSON.stringify({ ok: failures.length === 0, durationMs: duration, ...r, pageGeoms: after.geoms.length }, null, 2))

  if (external.length || errors.length) failures.push(`unexpected requests/errors: ${JSON.stringify({ external, errors })}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS in-process Python analysis on the live model')
} finally { await browser.close() }
