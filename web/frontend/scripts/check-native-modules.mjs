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
// Example scripts import Constants at the top level, so it ships with the console.
const constantsSource = resolve(frontend, '../../examples/scripts/python_scripts/Constants.py')
const constantsBundled = resolve(frontend, 'src/dualWasmProbe/python/Constants.py')
if (!(await readFile(constantsSource)).equals(await readFile(constantsBundled))) {
  throw new Error('Bundled example Constants.py drifted from examples/scripts/python_scripts/Constants.py')
}
const apiDir = process.env.VSP_API_DIR ?? resolve(frontend, '../../src/geom_api')
const defines = await readFile(resolve(apiDir, 'APIDefines.h'), 'utf8')
if (!/\bSET_ALL\s*=\s*0\s*,/.test(defines)) throw new Error('SET_ALL shim no longer matches native APIDefines.h')
// Check the live facade without requiring Python in the frontend build environment.
const facade = await readFile(resolve(frontend, 'src/dualWasmProbe/python/openvsp_live.py'), 'utf8')
for (const [enumName, prefix] of [['XSEC_CRV_TYPE', 'XS_'], ['SUBSURF_TYPE', 'SS_']]) {
  const native = defines.match(new RegExp(`\\benum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`))
  if (!native) throw new Error(`Missing native ${enumName}`)
  const entries = native[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').split(',').map(s => s.trim()).filter(Boolean)
  const assignments = facade.match(new RegExp(`^\\((${prefix}[A-Z0-9_,\\s]+${prefix}NUM_TYPES)\\)\\s*=\\s*range\\((\\d+)\\)`, 'm'))
  if (!assignments) throw new Error(`Missing facade ${enumName} range`)
  const names = assignments[1].split(',').map(s => s.trim())
  let current = -1, i = 0
  for (const entry of entries) {
    const [name, explicit] = entry.split('=').map(s => s.trim())
    current = explicit === undefined ? current + 1 : Number(explicit)
    if (name === 'XS_UNDEFINED') {
      if (!new RegExp(`^${name}\\s*=\\s*${current}\\s*$`, 'm').test(facade)) throw new Error(`Facade enum drift: ${name}`)
    } else if (names[i++] !== name || current !== i - 1) throw new Error(`Facade enum drift: ${name}`)
  }
  if (i !== Number(assignments[2]) || i !== names.length) throw new Error(`Facade enum size drift: ${enumName}`)
}
console.log('Bundled original Python modules and facade constants match source')
