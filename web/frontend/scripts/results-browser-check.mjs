// Result management over the live engine: find/count/delete results.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/results-browser-check.mjs
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

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
vsp.Update()
vsp.SetAnalysisInputDefaults('DegenGeom')
root1 = vsp.ExecAnalysis('DegenGeom')
root2 = vsp.ExecAnalysis('DegenGeom')
ids_before = vsp.GetAllResultsIDs()
names = vsp.GetAllResultsNames()
count = vsp.GetNumResults('DegenGeom')
first = vsp.FindResultsID('DegenGeom', 0)
latest = vsp.FindLatestResultsID('DegenGeom')
missing = vsp.FindResultsID('NoSuchResult')
vsp.DeleteResult(first)
ids_after_one = vsp.GetAllResultsIDs()
count_after_one = vsp.GetNumResults('DegenGeom')
vsp.DeleteResult('missing-id')
vsp.DeleteAllResults()
ids_after_all = vsp.GetAllResultsIDs()
count_after_all = vsp.GetNumResults('DegenGeom')
json.dumps({'root1': root1, 'root2': root2, 'ids_before': ids_before, 'names': names,
            'count': count, 'first': first, 'latest': latest, 'missing': missing,
            'ids_after_one': ids_after_one, 'count_after_one': count_after_one,
            'ids_after_all': ids_after_all, 'count_after_all': count_after_all})
`))
  const v = typeof r === 'string' ? JSON.parse(r) : r
  if (!(v.count >= 2)) failures.push(`GetNumResults: ${JSON.stringify(v.count)}`)
  if (!v.ids_before.includes(v.first) || !v.ids_before.includes(v.latest)) failures.push(`find returned unknown IDs: ${JSON.stringify(v)}`)
  if (v.first === v.latest) failures.push(`first and latest are the same: ${JSON.stringify(v)}`)
  if (v.latest !== v.root2) failures.push(`latest is not the newest result: ${JSON.stringify(v)}`)
  if (v.missing !== '') failures.push(`missing result should be empty: ${JSON.stringify(v.missing)}`)
  if (!v.names.includes('DegenGeom')) failures.push(`GetAllResultsNames missing DegenGeom: ${JSON.stringify(v.names)}`)
  if (v.ids_after_one.includes(v.first)) failures.push(`DeleteResult did not remove the result: ${JSON.stringify(v)}`)
  if (!(v.count_after_one === v.count - 1)) failures.push(`count after one delete: ${JSON.stringify(v)}`)
  if (v.ids_after_all.length !== 0 || v.count_after_all !== 0) failures.push(`DeleteAllResults left results: ${JSON.stringify(v)}`)

  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS result management: find/count/latest/delete/delete-all')
} finally { await browser.close() }
