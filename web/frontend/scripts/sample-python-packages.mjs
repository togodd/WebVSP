// Fixed, local-source browser audit; never accepts arbitrary code from the page.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const root = new URL('../../../', import.meta.url)
const source = async (path) => readFile(new URL(path, root), 'utf8')
const sources = {
  units: await source('src/python_api/packages/utilities/utilities/units.py'),
  transforms: await source('src/python_api/packages/utilities/utilities/transformations.py'),
  nativeUtilities: await source('src/python_api/packages/openvsp/openvsp/utilities.py'),
  files: await source('src/python_api/packages/utilities/utilities/files.py'),
  utilitiesInit: await source('src/python_api/packages/utilities/utilities/__init__.py'),
}
const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const external = []
  page.on('request', (r) => { if (new URL(r.url()).origin !== new URL(base).origin) external.push(r.url()) })
  await page.goto(base)
  const result = await page.evaluate(async ({ sources, base }) => {
    const workerSource = `
      self.onmessage = async ({data}) => {
        try {
          const {loadPyodide} = await import(new URL('pyodide/pyodide.mjs', data.base).href)
          const p = await loadPyodide({indexURL:new URL('pyodide/', data.base).href})
          p.FS.mkdirTree('/pkg/utilities')
          p.FS.mkdirTree('/standalone/utilities')
          p.FS.writeFile('/standalone/utilities/__init__.py', '')
          p.FS.writeFile('/standalone/utilities/units.py', data.sources.units)
          p.FS.writeFile('/pkg/utilities/__init__.py', data.sources.utilitiesInit)
          p.FS.writeFile('/pkg/utilities/files.py', data.sources.files)
          p.FS.writeFile('/pkg/utilities/units.py', data.sources.units)
          p.FS.writeFile('/pkg/units.py', data.sources.units)
          p.FS.writeFile('/pkg/transforms.py', data.sources.transforms)
          p.FS.writeFile('/pkg/nativeUtilities.py', data.sources.nativeUtilities)
          p.FS.writeFile('/pkg/files.py', data.sources.files)
          p.runPython("import sys; sys.path.insert(0, '/pkg')")
          const result = p.runPython(data.test)
          self.postMessage({result})
        } catch (e) { self.postMessage({error:String(e)}) }
      }`
    const worker = new Worker(URL.createObjectURL(new Blob([workerSource], {type:'text/javascript'})), {type:'module'})
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Pyodide audit timed out')), 120000)
        worker.onmessage = ({data}) => { clearTimeout(timer); data.error ? reject(new Error(data.error)) : resolve(JSON.parse(data.result)) }
        worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)) }
        worker.postMessage({sources, base, test: `
import json, math, sys, subprocess, importlib.util
out = {}
def attempt(name, func):
    try: out[name] = {'status':'passed', 'value':func()}
    except Exception as e: out[name] = {'status':'exception', 'type':type(e).__name__, 'message':str(e)}
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
def units_test():
    u = load('/pkg/units.py', 'audit_units')
    assert abs(u.degC2degF(100) - 212) < 1e-9
    assert abs(u.degF2degC(32)) < 1e-9
    assert abs(u.gauge2diam(36) - .005) < 1e-12
    return {'degC2degF_100': u.degC2degF(100), 'gauge2diam_36':u.gauge2diam(36)}
def numpy_test():
    import numpy
    return numpy.__version__
def transforms_test():
    sys.path.insert(0, '/standalone')
    try: return load('/pkg/transforms.py', 'audit_transforms').TransMatrix().mat.tolist()
    finally:
        sys.path.pop(0)
        sys.modules.pop('utilities', None)
        sys.modules.pop('utilities.units', None)
def full_utilities_import():
    return load('/pkg/nativeUtilities.py', 'audit_openvsp_utilities').__name__
def files_import():
    return load('/pkg/files.py', 'audit_files').__name__
def subprocess_test():
    return subprocess.run(['/bin/echo','webvsp'], capture_output=True, text=True, check=True).stdout
attempt('units_full_module', units_test)
attempt('numpy_import', numpy_test)
attempt('transformations_full_module', transforms_test)
attempt('openvsp_utilities_full_module', full_utilities_import)
attempt('files_full_module', files_import)
attempt('subprocess_echo', subprocess_test)
json.dumps({'python':sys.version, 'cases':out})
`})
      })
    } finally { worker.terminate() }
  }, {sources, base})
  if (external.length) throw new Error(`Unexpected external requests: ${JSON.stringify(external)}`)
  if (result.cases.units_full_module.status !== 'passed') throw new Error(`Units case failed: ${JSON.stringify(result)}`)
  console.log(JSON.stringify({...result, externalRequests:external.length}, null, 2))
} finally { await browser.close() }
