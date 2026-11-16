/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'
import facade from './python/openvsp.py?raw'
import syncGenerated from './python/_sync_generated.py?raw'
import nativeUtility from './python/native/openvsp_utilities.py?raw'
import nativeDegenParser from './python/native/degen_geom_parse.py?raw'
import nativePatches from './python/native/surface_patches.py?raw'
import degenInit from './python/native/degen_geom/__init__.py?raw'
import degenModule from './python/native/degen_geom/degen_geom.py?raw'
import utilitiesInit from './python/native/utilities/__init__.py?raw'
import utilitiesFiles from './python/native/utilities/files.py?raw'
import utilitiesUnits from './python/native/utilities/units.py?raw'
import utilitiesTransforms from './python/native/utilities/transformations.py?raw'
import p1Analysis from './python/p1_analysis.py?raw'
import p1Smoke from './python/p1_smoke.py?raw'

const scope = self as unknown as DedicatedWorkerGlobalScope
let started = false
scope.onmessage = ({ data }: MessageEvent<{ base: string; model: string; snapshots: Record<string, string> }>) => {
  if (started) return // A disposable worker accepts at most one request.
  started = true
  void (async () => {
    if (!['WING', 'PROP'].includes(data.model) || typeof data.snapshots?.DegenGeom !== 'string' || typeof data.snapshots?.SurfacePatches !== 'string') throw new Error('Invalid P1 Python diagnostic input')
    const base = new URL('pyodide/', data.base).href
    const { loadPyodide } = await import(/* @vite-ignore */ new URL('pyodide.mjs', base).href) as { loadPyodide: (options: { indexURL: string }) => Promise<PyodideInterface> }
    const pyodide = await loadPyodide({ indexURL: base })
    await pyodide.loadPackage(['numpy', 'six'], { checkIntegrity: true })
    pyodide.registerJsModule('sync_bridge', { request: () => { throw new Error('P1 isolated diagnostic cannot access the page engine') } })
    pyodide.registerJsModule('p1_snapshot', { get_snapshot: (analysis: string) => {
      if (analysis !== 'DegenGeom' && analysis !== 'SurfacePatches') throw new Error('Unsupported isolated analysis')
      return data.snapshots[analysis]
    } })
    for (const dir of ['/p1-probe', '/p1-probe/utilities', '/p1-probe/degen_geom']) pyodide.FS.mkdirTree(dir)
    for (const [name, content] of Object.entries({
      'openvsp.py': facade, '_sync_generated.py': syncGenerated, 'native_openvsp_utilities.py': nativeUtility,
      'native_degen_geom_parse.py': nativeDegenParser, 'native_surface_patches.py': nativePatches,
      'degen_geom/__init__.py': degenInit, 'degen_geom/degen_geom.py': degenModule,
      'utilities/__init__.py': utilitiesInit, 'utilities/files.py': utilitiesFiles,
      'utilities/units.py': utilitiesUnits, 'utilities/transformations.py': utilitiesTransforms,
      'p1_analysis.py': p1Analysis,
    })) pyodide.FS.writeFile(`/p1-probe/${name}`, content)
    pyodide.runPython("import sys; sys.path.insert(0, '/p1-probe')")
    const value = pyodide.runPython(p1Smoke) as string
    scope.postMessage({ type: 'done', value })
  })().catch((error: unknown) => scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) }))
}
