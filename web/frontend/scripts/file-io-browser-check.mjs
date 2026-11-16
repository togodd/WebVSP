// Product check for the Python file APIs and the workspace bridge.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/file-io-browser-check.mjs
//
// Covers ReadVSPFile, WriteVSPFile, ExportFile, ImportFile, SetVSP3FileName,
// GetVSPFileName, ClearVSPModel, relative paths in /work, the console workspace
// row, and writing new files back to the page on "同步".
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const failures = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
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
  await page.waitForFunction(() => typeof window.__runPython === 'function' && typeof window.__webvspWorkspaceTest === 'object' && typeof window.__webvspFileIO === 'object', null, { timeout: 120_000 })

  const runPython = async (code) => {
    const result = await page.evaluate((c) => window.__runPython(c), code)
    return typeof result === 'string' ? JSON.parse(result) : result
  }
  const readFile = (path) => page.evaluate((p) => window.__webvspFileIO.read(p), path)
  const mount = (files) => page.evaluate((f) => window.__webvspWorkspaceTest.mount(f), files)
  const mountHandle = (files) => page.evaluate((f) => window.__webvspWorkspaceTest.mountHandle(f), files)
  const captureSave = (on) => page.evaluate((v) => window.__webvspFileIO.captureSave(v), on)
  const takeSaved = () => page.evaluate(() => window.__webvspFileIO.takeSaved())

  // Seed a model through the Python API, then mount it as the workspace.
  const seed = await runPython(`
import json, openvsp as vsp
w = vsp.AddGeom('WING')
vsp.SetParmVal(w, 'TotalSpan', 'WingGeom', 12.0)
vsp.Update()
vsp.WriteVSPFile('/work/seed.vsp3')
json.dumps({'wing': w, 'name': vsp.GetVSPFileName()})
`)
  if (!String(seed.name).startsWith('/work/')) failures.push(`seed model name: ${JSON.stringify(seed)}`)
  const seedBytes = await readFile('/work/seed.vsp3')
  const mounted = await mountHandle([{ name: 'in.vsp3', base64: seedBytes }])
  if (mounted !== 1) failures.push(`directory mount copied ${mounted} files instead of 1`)

  // All seven APIs in one session; relative paths resolve in /work.
  const r = await runPython(`
import json, openvsp as vsp
vsp.ClearVSPModel()
vsp.ReadVSPFile('in.vsp3')
read_name = vsp.GetVSPFileName()
read_count = len(vsp.FindGeoms())
vsp.SetVSP3FileName('renamed.vsp3')
set_name = vsp.GetVSPFileName()
vsp.WriteVSPFile('out.vsp3')
write_name = vsp.GetVSPFileName()
vsp.ExportFile('out.stl', vsp.SET_ALL, vsp.EXPORT_STL)
vsp.ClearVSPModel()
after_clear = len(vsp.FindGeoms())
imported = vsp.ImportFile('out.stl', vsp.IMPORT_STL)
import_count = len(vsp.FindGeoms())
vsp.ExportFile('new.stl', vsp.SET_ALL, vsp.EXPORT_STL)
json.dumps({'read_name': read_name, 'read_count': read_count, 'set_name': set_name,
            'write_name': write_name, 'after_clear': after_clear,
            'imported': imported, 'import_count': import_count})
`)
  if (!String(r.read_name).endsWith('/work/in.vsp3')) failures.push(`ReadVSPFile name: ${JSON.stringify(r)}`)
  if (r.read_count < 1) failures.push(`ReadVSPFile did not load a model: ${JSON.stringify(r)}`)
  if (String(r.set_name) !== '/work/renamed.vsp3') failures.push(`SetVSP3FileName: ${JSON.stringify(r)}`)
  if (String(r.write_name) !== '/work/out.vsp3') failures.push(`WriteVSPFile name: ${JSON.stringify(r)}`)
  if (r.after_clear !== 0) failures.push(`ClearVSPModel left geometry: ${JSON.stringify(r)}`)
  if (!r.imported || r.import_count < 1) failures.push(`ImportFile failed: ${JSON.stringify(r)}`)

  // ExportFile produced a real STL; the second export is a new (unlinked) file.
  const stl = Buffer.from(await readFile('/work/out.stl'), 'base64')
  if (stl.length < 84) failures.push(`ExportFile wrote a suspicious STL: ${stl.length} bytes`)
  if (!stl.includes(Buffer.from('facet')) && !stl.includes(Buffer.from('solid'))) {
    failures.push(`ExportFile output is not an ASCII STL: ${stl.subarray(0, 40).toString('utf8')}`)
  }

  // "同步" hands Python-created files back to the page (download when no folder).
  await captureSave(true)
  await page.click('[data-testid="console-open"]')
  await page.waitForSelector('.py-console-workspace')
  await page.click('.py-console-workspace button:nth-of-type(3)')
  await page.waitForTimeout(500)
  const saved = await takeSaved()
  if (!saved) failures.push('同步 did not hand back a Python-created file')

  // Relative paths may not escape the workspace.
  const escaped = await runPython(`
import json, openvsp as vsp
try:
    vsp.ReadVSPFile('../outside.vsp3')
except ValueError as exc:
    result = str(exc)
else:
    result = 'no error'
json.dumps(result)
`)
  if (!String(escaped).includes('escapes')) failures.push(`workspace escape not rejected: ${JSON.stringify(escaped)}`)

  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS Python file APIs + workspace: read/write/export/import/name/clear, sync')
} finally { await browser.close() }
