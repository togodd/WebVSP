// Fail builds when bundled original Python modules differ from source.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const frontend = fileURLToPath(new URL('../', import.meta.url))
const source = process.env.VSP_PYTHON_PACKAGES_DIR ?? resolve(frontend, '../../src/python_api/packages')
for (const [original, bundled] of [
  ['openvsp/openvsp/utilities.py', 'openvsp_utilities.py'],
  ['openvsp/openvsp/degen_geom_parse.py', 'degen_geom_parse.py'],
  ['openvsp/openvsp/surface_patches.py', 'surface_patches.py'],
  ['degen_geom/degen_geom/__init__.py', 'degen_geom/__init__.py'],
  ['degen_geom/degen_geom/degen_geom.py', 'degen_geom/degen_geom.py'],
  ['utilities/utilities/__init__.py', 'utilities/__init__.py'],
  ['utilities/utilities/files.py', 'utilities/files.py'],
  ['utilities/utilities/units.py', 'utilities/units.py'],
  ['utilities/utilities/uberlogging.py', 'utilities/uberlogging.py'],
  ['utilities/utilities/wt_util.py', 'utilities/wt_util.py'],
  ['utilities/utilities/atmosphere.py', 'utilities/atmosphere.py'],
  ['utilities/utilities/simple_rotor_calcs.py', 'utilities/simple_rotor_calcs.py'],
  ['utilities/utilities/wt_util.py', 'utilities/wt_util.py'],
  ['utilities/utilities/transformations.py', 'utilities/transformations.py'],
]) {
  const a = await readFile(resolve(source, original))
  const b = await readFile(resolve(frontend, 'src/dualWasmProbe/python/native', bundled))
  if (!a.equals(b)) throw new Error(`Original Python module drift: ${original}`)
}
const apiDir = process.env.VSP_API_DIR ?? resolve(frontend, '../../src/geom_api')
const defines = await readFile(resolve(apiDir, 'APIDefines.h'), 'utf8')
if (!/\bSET_ALL\s*=\s*0\s*,/.test(defines)) throw new Error('SET_ALL import shim no longer matches native APIDefines.h')
console.log('Bundled original Python modules and SET_ALL shim match source')
