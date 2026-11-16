// Minimal closed-loop test for the Python file-I/O bridge.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4173/ node scripts/file-io-browser-check.mjs
//
// A: Python writes a model into the engine FS -> the page can read the bytes.
// B: the page puts bytes into the engine FS -> Python ReadVSPFile loads them.
// C: Python awaits the page picker/save helpers (open_into_engine/save_from_engine).
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
  await page.waitForFunction(() => typeof window.__runPython === 'function' && typeof window.__webvspFileIO === 'object', null, { timeout: 120_000 })

  const runPython = async (code) => {
    const result = await page.evaluate((c) => window.__runPython(c), code)
    return typeof result === 'string' ? JSON.parse(result) : result
  }
  const readFile = (path) => page.evaluate((p) => window.__webvspFileIO.read(p), path)
  const putFile = (name, base64) => page.evaluate(({ n, b }) => window.__webvspFileIO.put(n, b), { n: name, b: base64 })
  const nextFile = (name, base64) => page.evaluate(({ n, b }) => window.__webvspFileIO.nextFile(n, b), { n: name, b: base64 })
  const captureSave = (on) => page.evaluate((v) => window.__webvspFileIO.captureSave(v), on)
  const takeSaved = () => page.evaluate(() => window.__webvspFileIO.takeSaved())
  const newModel = () => page.evaluate(() => window.__webvspEngine.request('POST', '/file/new'))

  // A: Python -> engine FS -> page.
  const a = await runPython(`
import json, openvsp as vsp
w = vsp.AddGeom('WING')
vsp.SetParmVal(w, 'TotalSpan', 'WingGeom', 12.0)
vsp.Update()
vsp.WriteVSPFile('/home/web_user/py-write.vsp3')
json.dumps({'wing': w, 'geoms': vsp.FindGeoms()})
`)
  const written = Buffer.from(await readFile('/home/web_user/py-write.vsp3'), 'base64')
  if (!written.includes(Buffer.from('<Vsp_Geometry>'))) failures.push(`Python-written file is not an OpenVSP model: ${written.subarray(0, 80).toString('utf8')}`)
  if (written.length < 100) failures.push(`Python-written file is too small: ${written.length}`)

  // B: page -> engine FS -> Python.
  await newModel()
  await putFile('from-page.vsp3', written.toString('base64'))
  const b = await runPython(`
import json, openvsp as vsp
vsp.ReadVSPFile('/home/web_user/from-page.vsp3')
ids = vsp.FindGeoms()
json.dumps({'count': len(ids), 'types': [vsp.GetGeomTypeName(g) for g in ids],
            'span': vsp.GetParmVal(ids[0], 'TotalSpan', 'WingGeom') if ids else None})
`)
  if (b.count < 1 || !b.types.some((t) => t === 'Wing' || t === 'WingGeom')) failures.push(`ReadVSPFile did not restore the model: ${JSON.stringify(b)}`)
  if (Math.abs(Number(b.span) - 12) > 1e-9) failures.push(`Span changed after ReadVSPFile: ${JSON.stringify(b)}`)

  // C: Python awaits the page file helpers.
  await newModel()
  await nextFile('picked.vsp3', written.toString('base64'))
  await captureSave(true)
  const c = await runPython(`
import json, openvsp as vsp, webvsp_files
path = await webvsp_files.open_into_engine()
vsp.ReadVSPFile(path)
count = len(vsp.FindGeoms())
vsp.WriteVSPFile('/home/web_user/py-save.vsp3')
await webvsp_files.save_from_engine('/home/web_user/py-save.vsp3', 'py-save.vsp3')
json.dumps({'path': path, 'count': count})
`)
  if (!String(c.path).startsWith('/home/web_user/')) failures.push(`Unexpected picked path: ${JSON.stringify(c)}`)
  if (c.count < 1) failures.push(`Picked file did not load: ${JSON.stringify(c)}`)
  const saved = await takeSaved()
  if (!saved || saved.name !== 'py-save.vsp3') failures.push(`save_from_engine did not capture: ${JSON.stringify(saved)}`)
  else if (!Buffer.from(saved.base64, 'base64').includes(Buffer.from('<Vsp_Geometry>'))) failures.push(`Saved file is not an OpenVSP model: ${Buffer.from(saved.base64, 'base64').subarray(0, 80).toString('utf8')}`)

  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS Python file I/O bridge: WriteVSPFile -> page, page -> ReadVSPFile, awaited open/save')
} finally { await browser.close() }
