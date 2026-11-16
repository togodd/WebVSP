// Fail builds when a bundled original Python file differs from src/python_api.
// The bundled tree mirrors src/python_api/packages, so every entry is compared
// at the same relative path; a missing file means it is deliberately not shipped.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const frontend = fileURLToPath(new URL('../', import.meta.url))
const source = process.env.VSP_PYTHON_PACKAGES_DIR ?? resolve(frontend, '../../src/python_api/packages')
const bundled = resolve(frontend, 'src/dualWasmProbe/python/packages')
for (const file of [
  'openvsp/openvsp/utilities.py',
  'openvsp/openvsp/degen_geom_parse.py',
  'openvsp/openvsp/surface_patches.py',
  'degen_geom/degen_geom/__init__.py',
  'degen_geom/degen_geom/degen_geom.py',
  'utilities/utilities/__init__.py',
  'utilities/utilities/files.py',
  'utilities/utilities/units.py',
  'utilities/utilities/transformations.py',
  'utilities/utilities/uberlogging.py',
  'utilities/utilities/wt_util.py',
  'utilities/utilities/atmosphere.py',
  'utilities/utilities/simple_rotor_calcs.py',
]) {
  const a = await readFile(resolve(source, file))
  const b = await readFile(resolve(bundled, file))
  if (!a.equals(b)) throw new Error(`Original Python module drift: ${file}`)
}
const apiDir = process.env.VSP_API_DIR ?? resolve(frontend, '../../src/geom_api')
const defines = await readFile(resolve(apiDir, 'APIDefines.h'), 'utf8')
if (!/\bSET_ALL\s*=\s*0\s*,/.test(defines)) throw new Error('SET_ALL shim no longer matches native APIDefines.h')
console.log('Bundled original Python modules and SET_ALL shim match source')
