/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'
import nativeUtility from './python/packages/openvsp/openvsp/utilities.py?raw'
import nativeDegenParser from './python/packages/openvsp/openvsp/degen_geom_parse.py?raw'
import nativePatches from './python/packages/openvsp/openvsp/surface_patches.py?raw'
import degenInit from './python/packages/degen_geom/degen_geom/__init__.py?raw'
import degenModule from './python/packages/degen_geom/degen_geom/degen_geom.py?raw'
import utilitiesInit from './python/packages/utilities/utilities/__init__.py?raw'
import utilitiesFiles from './python/packages/utilities/utilities/files.py?raw'
import utilitiesUnits from './python/packages/utilities/utilities/units.py?raw'
import utilitiesUberlogging from './python/packages/utilities/utilities/uberlogging.py?raw'
import utilitiesWtUtil from './python/packages/utilities/utilities/wt_util.py?raw'
import utilitiesTransforms from './python/packages/utilities/utilities/transformations.py?raw'
import p1Analysis from './python/p1_analysis.py?raw'
import p1Smoke from './python/p1_smoke.py?raw'

const scope = self as unknown as DedicatedWorkerGlobalScope
let started = false
scope.onmessage = ({ data }: MessageEvent<{ base: string; model: string; snapshots: Record<string, string> }>) => {
  if (started) return // A disposable worker accepts at most one request.
  started = true
  void (async () => {
    if (!['WING', 'PROP', 'MODEL'].includes(data.model) ||
        !data.snapshots || typeof data.snapshots !== 'object' ||
        !Object.keys(data.snapshots).length ||
        Object.entries(data.snapshots).some(([name, raw]) => !['DegenGeom', 'SurfacePatches'].includes(name) || typeof raw !== 'string')) throw new Error('Invalid P1 Python diagnostic input')
    const base = new URL('pyodide/', data.base).href
    const { loadPyodide } = await import(/* @vite-ignore */ new URL('pyodide.mjs', base).href) as { loadPyodide: (options: { indexURL: string }) => Promise<PyodideInterface> }
    const pyodide = await loadPyodide({ indexURL: base })
    await pyodide.loadPackage(['numpy', 'six'], { checkIntegrity: true })
    pyodide.registerJsModule('sync_bridge', { request: () => { throw new Error('P1 isolated diagnostic cannot access the page engine') } })
    pyodide.registerJsModule('p1_snapshot', { get_snapshot: (analysis: string) => {
      if (analysis !== 'DegenGeom' && analysis !== 'SurfacePatches') throw new Error('Unsupported isolated analysis')
      return data.snapshots[analysis] ?? ''
    } })
    for (const dir of ['/p1-probe', '/p1-probe/utilities', '/p1-probe/degen_geom']) pyodide.FS.mkdirTree(dir)
    for (const [name, content] of Object.entries({
      'native_openvsp_utilities.py': nativeUtility,
      'native_degen_geom_parse.py': nativeDegenParser, 'native_surface_patches.py': nativePatches,
      'degen_geom/__init__.py': degenInit, 'degen_geom/degen_geom.py': degenModule,
      'utilities/__init__.py': utilitiesInit, 'utilities/files.py': utilitiesFiles,
      'utilities/units.py': utilitiesUnits, 'utilities/transformations.py': utilitiesTransforms,
      'utilities/uberlogging.py': utilitiesUberlogging, 'utilities/wt_util.py': utilitiesWtUtil,
      'p1_analysis.py': p1Analysis,
    })) pyodide.FS.writeFile(`/p1-probe/${name}`, content)
    pyodide.runPython("import sys; sys.path.insert(0, '/p1-probe')")
    const value = pyodide.runPython(p1Smoke) as string
    scope.postMessage({ type: 'done', value })
  })().catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
}
