// Smoke every public openvsp facade function in the live engine.
//
// For each callable it builds plausible arguments from the parameter names and
// classifies the outcome. A native OpenVSP error is an acceptable result: the
// point is to catch infrastructure faults only - an unknown engine request, a
// missing facade helper, an AttributeError, or a crash.
//
//   WEBVSP_TEST_PAGE=http://127.0.0.1:5191/ WEBVSP_TEST_CHROMIUM=... \
//   WEBVSP_TEST_WASM_DIR=../../build/vsp-wasm/wasm_engine node scripts/api-smoke-all.mjs
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { readFile as readTextFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const { WEBVSP_TEST_PAGE: base, WEBVSP_TEST_CHROMIUM: executablePath, WEBVSP_TEST_WASM_DIR: dir } = process.env
if (!base || !executablePath || !dir) throw Error('Set WEBVSP_TEST_PAGE, WEBVSP_TEST_CHROMIUM and WEBVSP_TEST_WASM_DIR')
const url = new URL(base)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('A disposable loopback server is required')
const source = resolve('../../web/wasm/engine/engine.cpp')
const files = Object.fromEntries(await Promise.all(['vsp.js', 'vsp.wasm'].map(async name => {
  const path = resolve(dir, name)
  const [body, info] = await Promise.all([readFile(path), stat(path)])
  if (name === 'vsp.wasm' && info.mtimeMs < (await stat(source)).mtimeMs) throw Error(`Stale WASM: ${path} is older than ${source}`)
  return [name, { path, body, hash: createHash('sha256').update(body).digest('hex') }]
})))
// Parameter types straight from VSP_Geom_API.h, so the smoke run passes values
// of the right kind instead of guessing from names.
const spec = JSON.parse(await readTextFile(resolve('../../web/wasm/engine/api_smoke_spec.json'), 'utf8'))
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  let page = await browser.newPage()
  const errors = [], external = [], served = new Set()
  const attach = async target => {
    target.on('pageerror', e => errors.push(e.message))
    target.on('console', msg => { if (msg.type() === 'error') errors.push(`console error: ${msg.text()}`) })
    await target.route('**/*', async route => {
    const request = new URL(route.request().url())
    if (request.origin !== url.origin) { external.push(request.href); return route.abort() }
    const match = request.pathname.match(/\/wasm\/(vsp\.js|vsp\.wasm)$/)
    if (match) {
      served.add(match[1])
        return route.fulfill({ status: 200, body: files[match[1]].body, headers: { 'content-type': match[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' } })
      }
      return route.continue()
    })
  }
  await attach(page)
  url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  try { await page.waitForSelector('[data-ready="1"]', { timeout: 30000 }) }
  catch (e) { throw Error(`Engine did not start: ${e.message}`) }
  await page.waitForFunction(() => typeof window.__runPython === 'function', null, { timeout: 120000 })
  assert.deepEqual([...served].sort(), ['vsp.js', 'vsp.wasm'])
  console.log('WASM served from', files['vsp.wasm'].path, 'sha256', files['vsp.wasm'].hash)

  // A malformed or timed-out response poisons a console session, so each batch
  // runs in a fresh one and a poisoned batch resumes past the culprit.
  const CHUNK = 120
  const names = await page.evaluate(async () => {
    const { startConsoleSession } = await import('/src/dualWasmProbe/syncProbe.ts')
    const session = await startConsoleSession()
    try {
      const result = await session.run(`
import json, openvsp as vsp
json.dumps(sorted(n for n in dir(vsp) if not n.startswith('_') and callable(getattr(vsp, n))))
`, true)
      return JSON.parse(result.value)
    } finally { session.close() }
  })
  const skipped = new Set(['ExecAnalysis', 'ReadVSPFile', 'WriteVSPFile', 'ExportFile', 'ImportFile',
    'ClearVSPModel', 'KillVSPAERO', 'SetVSP3FileName', 'get_instance',
    'GetResultTree', 'parse_results_tree', 'parse_results_object',
    'parse_results_object_fast', 'parse_surface_patches_fast',
    // These block OpenVSP's thread on purpose inside a console session: the
    // mirrored GUI screens wait for the page, and VSPCrash/VSPExit never return.
    'StartGUI', 'StopGUI', 'SetGUIRunning', 'IsGUIRunning',
    'HideScreen', 'ShowScreen', 'VSPCrash', 'VSPExit'])
  // Prefixes that run a solver, mesh the model or touch files: covered by their
  // own browser checks and too slow or destructive for a signature smoke test.
  const skipPrefixes = ['Fea', 'Cfd', 'VSPAERO', 'FitModel', 'Compute', 'UpdateParasite',
    'Write', 'Read', 'Import', 'Export', 'InsertVSPFile', 'SetVSP3FileName']
  const heavy = name => skipPrefixes.some(prefix => name.startsWith(prefix))
  const report = { ok: 0, native_error: 0, validation: 0, bad: [], skipped: skipped.size, heavy: names.filter(heavy).length }
  let cursor = 0
  while (cursor < names.length) {
    const batch = names.slice(cursor, cursor + CHUNK).filter(name => !skipped.has(name) && !heavy(name))
    console.log(`batch ${cursor}..${cursor + CHUNK}`)
    const outcome = await Promise.race([
      page.evaluate(async ({ batch, smokeSpec }) => {
      const { startConsoleSession } = await import('/src/dualWasmProbe/syncProbe.ts')
      const session = await startConsoleSession()
      try {
        const result = await session.run(`
import json, inspect, openvsp as vsp
NAMES = ${JSON.stringify(batch)}
SPEC = ${JSON.stringify(Object.fromEntries(batch.map(n => [n, smokeSpec[n] ?? []])))}

def context():
    vsp.ClearVSPModel()
    pod = vsp.AddGeom('POD')
    wing = vsp.AddGeom('WING')
    vsp.AddGeom('FUSELAGE')
    vsp.Update()
    ctx = {}
    ctx['geom'] = pod
    ctx['parm'] = vsp.GetGeomParmIDs(pod)[0]
    surf = vsp.GetXSecSurf(wing, 0)
    ctx['xsec_surf'] = surf
    ctx['xsec'] = vsp.GetXSec(surf, 1)
    ctx['sub'] = vsp.AddSubSurf(pod, vsp.SS_RECTANGLE)
    ctx['collection'] = vsp.GetChildCollection(pod)
    ctx['attribute'] = vsp.AddAttributeDouble(ctx['collection'], 'SmokeAttribute', 1.0)
    try:
        ctx['result'] = vsp.ExecAnalysis('MassProp')
    except Exception:
        ctx['result'] = ''
    return ctx

def pick(kind, ctx):
    if kind == 'string':
        return ctx['geom']
    if kind == 'int':
        return 0
    if kind == 'bool':
        return True
    if kind == 'double':
        return 0.5
    if kind in ('vector<string>',):
        return ['Smoke']
    if kind in ('vector<int>',):
        return [0]
    if kind in ('vector<double>',):
        return [0.5]
    if kind in ('vector<vec3d>', 'vector<vec3d >'):
        return [(0.0, 0.0, 0.0)]
    if kind in ('vec3d',):
        return (0.0, 0.0, 0.0)
    if kind in ('vec2d',):
        return (0.0, 0.0)
    if 'matrix' in kind or 'vector<vector' in kind:
        return [[1.0]]
    return ctx['geom']

def guess(param, ctx):
    """Value for a hand-written wrapper without a spec entry."""
    name = param.lower()
    if 'collection' in name or 'coll' in name: return ctx['collection']
    if 'attribute' in name: return ctx['attribute']
    if 'xsec_surf' in name or 'surf_id' in name: return ctx['xsec_surf']
    if 'xsec' in name: return ctx['xsec']
    if 'sub' in name: return ctx['sub']
    if 'result' in name: return ctx['result'] or 'missing'
    if 'parm' in name or name in ('pid', 'id'): return ctx['parm']
    if 'analysis' in name: return 'MassProp'
    if 'index' in name: return 0
    if name in ('u','w','r','s','t','value','distance','tolerance','width','height'): return 0.5
    if 'flag' in name or name.startswith('is_') or 'enable' in name or 'fixed' in name: return True
    if 'mode' in name: return ''
    if 'file' in name or 'path' in name: return '/work/smoke.vsp3'
    if 'point' in name or name in ('pt','pnt'): return [(0.0,0.0,0.0)] if name.endswith('s') else (0.0,0.0,0.0)
    if 'matrix' in name or 'rows' in name: return [[1.0,2.0]]
    if 'group' in name: return 'XForm'
    if 'name' in name: return 'Smoke'
    return ctx['geom']

def call_one(name, fn, ctx):
    types = SPEC.get(name) or []
    if types:
        args = [pick(kind, ctx) for kind in types]
    else:
        params = list(inspect.signature(fn).parameters.values())
        args = []
        for param in params:
            if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD): break
            if param.default is not param.empty: break
            args.append(guess(param.name, ctx))
    return fn(*args)

ctx = context()
ok = 0
native = []
validation = []
bad = []
poisoned = ''
for name in NAMES:
    fn = getattr(vsp, name, None)
    if not callable(fn):
        continue
    try:
        call_one(name, fn, ctx)
        ok += 1
    except vsp.OpenVSPError as exc:
        message = str(exc)
        if exc.code == 'TRANSPORT' or 'Unknown API function' in message or 'Invalid synchronous' in message:
            bad.append([name, message[:110]])
            poisoned = name
            break
        native.append([name, message[:80]])
    except (ValueError, TypeError, IndexError, KeyError) as exc:
        validation.append([name, type(exc).__name__])
    except Exception as exc:
        bad.append([name, type(exc).__name__ + ': ' + str(exc)[:100]])
    try:
        vsp.GetGeomName(ctx['geom'])
    except Exception:
        try:
            ctx = context()
        except Exception:
            ctx = {'geom': '', 'parm': '', 'xsec_surf': '', 'xsec': '', 'sub': '',
                   'collection': '', 'attribute': '', 'result': ''}
json.dumps({'ok': ok, 'native': len(native), 'validation': len(validation),
            'validation_rejects': [name for name, _ in validation],
            'bad': bad, 'poisoned': poisoned, 'done': len(NAMES)})
`, true)
        if (!result.ok) return { failed: result.error, bad: [], poisoned: 'session', ok: 0, native: 0, validation: 0 }
        return JSON.parse(result.value)
      } finally { session.close() }
      }, { batch, smokeSpec: spec }),
      // A single heavy native call can block the engine thread; give the batch a
      // budget and skip past it instead of hanging the run.
      new Promise(resolve => setTimeout(() => resolve({ timedOut: true, batch }), 120_000)),
    ])

    if (outcome.timedOut) {
      console.log(`batch at ${cursor} timed out; skipping ${CHUNK} names`)
      report.bad.push([batch[0] ?? '?', 'batch timed out'])
      await page.close().catch(() => {})
      page = await browser.newPage()
      cursor += CHUNK
      continue
    }
    if (outcome.failed) {
      // The session died without a usable report: skip one name and continue.
      report.bad.push([batch[0] ?? '?', `session failed: ${String(outcome.failed).slice(0, 90)}`])
      cursor += 1
      continue
    }
    report.ok += outcome.ok
    report.native_error += outcome.native
    report.validation += outcome.validation
    report.validation_rejects = [...(report.validation_rejects ?? []), ...(outcome.validation_rejects ?? [])]
    for (const entry of outcome.bad) report.bad.push(entry)
    if (outcome.poisoned) {
      // `batch` is filtered, so resolve the culprit against the unfiltered list.
      const index = names.indexOf(outcome.poisoned, cursor)
      report.bad.push([outcome.poisoned, 'blocked the engine thread (skipped)'])
      cursor = index >= 0 ? index + 1 : cursor + CHUNK
      // The page keeps a poisoned-request flag; only a new page clears it.
      await page.close().catch(() => {})
      page = await browser.newPage()
      await attach(page)
      await page.goto(url.href)
      await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
      continue
    }
    cursor += CHUNK
  }

  console.log('tested:', report.ok + report.native_error + report.validation + report.bad.length,
    'ok:', report.ok, 'native errors:', report.native_error,
    'validation rejects:', report.validation, 'skipped by name:', report.skipped,
    'skipped heavy families:', report.heavy)
  if (report.validation_rejects?.length) {
    console.log('validation rejects:', report.validation_rejects.sort().join(', '))
  }
  if (report.bad.length) {
    console.error('INFRASTRUCTURE FAILURES:')
    for (const [name, message] of report.bad) console.error('  ', name, '->', message)
    process.exitCode = 1
  } else {
    console.log('no infrastructure failures')
  }
  // Dummy paths make the XML loader and the program lookup complain; those are
  // expected while probing signatures, not infrastructure faults.
  const realErrors = errors.filter(message =>
    !/WARNING|Not Found|Expected here|failed to load|parse XML/.test(message))
  if (realErrors.length) { console.error('PAGE ERRORS:', realErrors.slice(0, 5)); process.exitCode = 1 }
  if (external.length) { console.error('EXTERNAL REQUESTS:', external.slice(0, 3)); process.exitCode = 1 }
} finally { await browser.close() }
