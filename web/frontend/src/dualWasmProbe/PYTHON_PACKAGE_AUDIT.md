# Python package reuse audit

This is a static inventory of `src/python_api/packages`, generated with the host Python stdlib module list. It excludes test and example files and non-`.py` files (including `openvsp/setup.py.in`) from module counts. A tier is a triage signal, not proof of browser compatibility; sampled runtime evidence is recorded separately below.

## Scope and tier definitions

- **A0 — pure Python**: standard-library-only code with no OpenVSP, process, filesystem, or GUI dependency.
- **A1 — package/dependency; unknown portability**: no OpenVSP/environment dependency, but imports a non-stdlib package or local package; runtime package availability and numerical parity must be tested.
- **B — OpenVSP model API**: primarily synchronous `openvsp` calls; potentially reusable after facade coverage and return-type checks.
- **C — mixed OpenVSP/environment**: OpenVSP plus files, subprocesses, plotting, or other desktop/runtime dependencies.
- **D — environment indicators**: no directly detected OpenVSP receiver but has file/path, process, or GUI indicators; importing os alone is a conservative indicator, not proof of incompatibility.

Only syntactic indicators are used: imports anywhere (including lazy/conditional), calls and attributes on receivers named vsp, vsp_module, openvsp or .vsp. It does not resolve aliases, wildcards, dynamic dispatch, transitive imports, constants imported directly, or argument overloads; local packages can hide environment dependencies. Counts include setup and __init__ files, nested functions and methods. A module tier is not a function tier, importability verdict, or reuse percentage. Possible false positives and negatives require manual review.

## Static totals

- Python modules scanned: **43**
- Functions and methods (AST definitions): **431**
- Classes: **78**
- Tiers: **{'A0 — pure Python': 3, 'A1 — package/dependency; unknown portability': 18, 'B — OpenVSP model API': 1, 'C — mixed OpenVSP/environment': 10, 'D — external environment': 11}**

## Module inventory

| Tier | Package | Module | Lines | Functions | Classes | OpenVSP symbols | Other flags / external imports |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| A1 — package/dependency; unknown portability | AvlPy | `AvlPy/avlpy/__init__.py` | 1 | 0 | 0 | — | third-party dependency; external: avlInput |
| C — mixed OpenVSP/environment | AvlPy | `AvlPy/avlpy/avlInput.py` | 1068 | 30 | 9 | `ExecAnalysis`, `SetIntAnalysisInput`, `Update`, `get_instance`, `parse_degen_geom` | OpenVSP API, filesystem/path, package-local, process/runner, third-party dependency; external: fortranformat, numpy, pandas, scipy |
| D — external environment | AvlPy | `AvlPy/setup.py` | 40 | 0 | 0 | — | filesystem/path, process/runner, third-party dependency; external: setuptools |
| A0 — pure Python | CHARM | `CHARM/charm/__init__.py` | 90 | 1 | 0 | — | —; external: — |
| A1 — package/dependency; unknown portability | CHARM | `CHARM/charm/__main__.py` | 38 | 0 | 0 | — | package-local; external: — |
| D — external environment | CHARM | `CHARM/charm/airfoil_helpers.py` | 304 | 4 | 0 | — | filesystem/path, package-local, third-party dependency; external: numpy, pandas, scipy |
| C — mixed OpenVSP/environment | CHARM | `CHARM/charm/input_automation.py` | 2259 | 113 | 10 | `GetGeomName`, `GetGeomTypeName`, `GetNumXSec`, `GetParmVal`, `GetXSec`, `GetXSecParm`, `GetXSecSurf`, `get_instance`, `get_single_propeller_info` | OpenVSP API, filesystem/path, package-local, process/runner, third-party dependency; external: numpy |
| D — external environment | CHARM | `CHARM/charm/output.py` | 1289 | 23 | 8 | — | GUI/plot, filesystem/path, package-local, process/runner, third-party dependency; external: fortranformat, matplotlib, numpy, pandas |
| A1 — package/dependency; unknown portability | CHARM | `CHARM/setup.py` | 50 | 0 | 0 | — | third-party dependency; external: setuptools |
| A1 — package/dependency; unknown portability | PyVSP | `PyVSP/pyvsp/__init__.py` | 1 | 0 | 0 | — | package-local; external: — |
| C — mixed OpenVSP/environment | PyVSP | `PyVSP/pyvsp/analysis_panel.py` | 197 | 5 | 1 | `DOUBLE_DATA`, `ExecAnalysis`, `GetAnalysisInputDoc`, `GetAnalysisInputNames`, `GetAnalysisInputType`, `GetDoubleAnalysisInput`, `GetIntAnalysisInput`, `GetNumAnalysisInputData`, `GetStringAnalysisInput`, `INT_DATA`, `ListAnalysis`, `STRING_DATA`, `SetAnalysisInputDefaults`, `SetDoubleAnalysisInput`, `SetIntAnalysisInput`, `SetStringAnalysisInput`, `VEC3D_DATA` | GUI/plot, OpenVSP API, package-local, third-party dependency; external: wx |
| C — mixed OpenVSP/environment | PyVSP | `PyVSP/pyvsp/pyvsp.py` | 746 | 30 | 3 | `CompVecPnt01`, `FindGeoms`, `FindParm`, `GetAndResetUpdateCount`, `GetNumMainSurfs`, `GetParmVal`, `GetUWTess01`, `GetVSPVersion`, `PopupMsg`, `ReadVSPFile`, `SET_ALL`, `ScreenGrab`, `SetParmVal`, `StartGUI`, `StopGUI`, `Update`, `UpdateGUI`, `VSPCrash`, `WriteVSPFile` | GUI/plot, OpenVSP API, filesystem/path, package-local, third-party dependency; external: numpy, vtk, wx |
| C — mixed OpenVSP/environment | PyVSP | `PyVSP/pyvsp/results_panel.py` | 85 | 2 | 1 | `DOUBLE_DATA`, `GetAllDataNames`, `GetDoubleResults`, `GetIntResults`, `GetNumData`, `GetResultsEntryDoc`, `GetResultsName`, `GetResultsType`, `GetStringResults`, `INT_DATA`, `STRING_DATA`, `VEC3D_DATA` | GUI/plot, OpenVSP API, third-party dependency; external: wx |
| C — mixed OpenVSP/environment | PyVSP | `PyVSP/pyvsp/user_prop_panel.py` | 101 | 3 | 1 | `FindContainer`, `FindContainerParmIDs`, `GetIntParmVal`, `GetParmName`, `GetParmType`, `GetParmVal`, `PARM_INT_TYPE`, `SetParmVal` | GUI/plot, OpenVSP API, third-party dependency; external: wx |
| A1 — package/dependency; unknown portability | PyVSP | `PyVSP/setup.py` | 38 | 0 | 0 | — | third-party dependency; external: setuptools |
| A1 — package/dependency; unknown portability | degen_geom | `degen_geom/degen_geom/__init__.py` | 21 | 0 | 0 | — | package-local; external: — |
| D — external environment | degen_geom | `degen_geom/degen_geom/degen_geom.py` | 355 | 19 | 10 | — | GUI/plot, package-local, third-party dependency; external: matplotlib, mpl_toolkits, numpy |
| A1 — package/dependency; unknown portability | degen_geom | `degen_geom/setup.py` | 31 | 0 | 0 | — | third-party dependency; external: setuptools |
| C — mixed OpenVSP/environment | openvsp | `openvsp/openvsp/__init__.py` | 91 | 2 | 0 | — | OpenVSP API, filesystem/path, package-local, third-party dependency; external: degen_geom_parse, facade, parasite_drag, surface_patches, vsp, vsp_g |
| D — external environment | openvsp | `openvsp/openvsp/conf.py` | 73 | 0 | 0 | — | filesystem/path, third-party dependency; external: sphinx_rtd_theme |
| B — OpenVSP model API | openvsp | `openvsp/openvsp/degen_geom_parse.py` | 68 | 1 | 0 | `GetNumData`, `GetStringResults`, `get_instance`, `parse_results_object` | OpenVSP API, package-local; external: — |
| C — mixed OpenVSP/environment | openvsp | `openvsp/openvsp/parasite_drag.py` | 179 | 4 | 1 | `ExecAnalysis`, `SetAnalysisInputDefaults`, `SetDoubleAnalysisInput`, `SetIntAnalysisInput`, `SetStringAnalysisInput`, `SetVSP3FileName`, `V_UNIT_MACH`, `get_instance`, `parse_results_object` | GUI/plot, OpenVSP API, package-local, third-party dependency; external: matplotlib, numpy, scipy |
| C — mixed OpenVSP/environment | openvsp | `openvsp/openvsp/surface_patches.py` | 149 | 5 | 3 | `ExecAnalysis`, `SetIntAnalysisInput`, `get_instance`, `parse_results_object`, `set_3d_axis_equal` | GUI/plot, OpenVSP API, package-local, third-party dependency; external: matplotlib, mpl_toolkits, numpy |
| C — mixed OpenVSP/environment | openvsp | `openvsp/openvsp/utilities.py` | 405 | 15 | 2 | `ClearVSPModel`, `DOUBLE_DATA`, `DOUBLE_MATRIX_DATA`, `EXPORT_SELIG_AIRFOIL`, `EXPORT_X3D`, `ExecAnalysis`, `ExportFile`, `FindGeom`, `GetAllDataNames`, `GetDoubleMatResults`, `GetDoubleResults`, `GetIntResults`, `GetParmVal`, `GetResultsName`, `GetResultsType`, `GetSetIndex`, `GetStringResults`, `GetVec3dResults`, `INT_DATA`, `ReadVSPFile`, `SET_ALL`, `STRING_DATA`, `SetAnalysisInputDefaults`, `SetIntAnalysisInput`, `Update`, `VEC3D_DATA`, `get_instance`, `parse_degen_geom` | GUI/plot, OpenVSP API, filesystem/path, package-local, third-party dependency; external: matplotlib, mpl_toolkits, numpy |
| A0 — pure Python | openvsp_config | `openvsp_config/openvsp_config/__init__.py` | 19 | 0 | 0 | — | —; external: — |
| A1 — package/dependency; unknown portability | openvsp_config | `openvsp_config/setup.py` | 33 | 0 | 0 | — | third-party dependency; external: setuptools |
| A1 — package/dependency; unknown portability | pyPMARC | `pyPMARC/pypmarc/__init__.py` | 21 | 0 | 0 | — | third-party dependency; external: pyPMARC |
| D — external environment | pyPMARC | `pyPMARC/pypmarc/pyPMARC.py` | 617 | 6 | 2 | — | GUI/plot, filesystem/path, third-party dependency; external: f90nml, matplotlib, numpy, pydantic |
| A1 — package/dependency; unknown portability | pyPMARC | `pyPMARC/setup.py` | 33 | 0 | 0 | — | third-party dependency; external: setuptools |
| A1 — package/dependency; unknown portability | utilities | `utilities/setup.py` | 33 | 0 | 0 | — | third-party dependency; external: setuptools |
| A1 — package/dependency; unknown portability | utilities | `utilities/utilities/__init__.py` | 22 | 0 | 0 | — | third-party dependency; external: files |
| A1 — package/dependency; unknown portability | utilities | `utilities/utilities/atmosphere.py` | 348 | 22 | 7 | — | package-local, third-party dependency; external: numpy, scipy |
| D — external environment | utilities | `utilities/utilities/files.py` | 198 | 15 | 5 | — | filesystem/path, third-party dependency; external: six |
| D — external environment | utilities | `utilities/utilities/plots.py` | 459 | 15 | 1 | — | GUI/plot, filesystem/path, third-party dependency; external: matplotlib, numpy, pandas, scipy |
| D — external environment | utilities | `utilities/utilities/runners.py` | 247 | 16 | 4 | — | process/runner, third-party dependency; external: multiprocessing_logging, numpy, pathos |
| A1 — package/dependency; unknown portability | utilities | `utilities/utilities/simple_rotor_calcs.py` | 518 | 26 | 0 | — | package-local, third-party dependency; external: numpy |
| A1 — package/dependency; unknown portability | utilities | `utilities/utilities/transformations.py` | 315 | 25 | 1 | — | package-local, third-party dependency; external: numpy |
| A0 — pure Python | utilities | `utilities/utilities/uberlogging.py` | 45 | 4 | 2 | — | —; external: — |
| A1 — package/dependency; unknown portability | utilities | `utilities/utilities/units.py` | 337 | 12 | 0 | — | third-party dependency; external: numpy |
| D — external environment | utilities | `utilities/utilities/wt_util.py` | 91 | 7 | 0 | — | filesystem/path, third-party dependency; external: numpy |
| A1 — package/dependency; unknown portability | vsp_airfoils | `vsp_airfoils/setup.py` | 27 | 0 | 0 | — | third-party dependency; external: setuptools |
| A1 — package/dependency; unknown portability | vsp_airfoils | `vsp_airfoils/vsp_airfoils/__init__.py` | 1 | 0 | 0 | — | package-local; external: — |
| D — external environment | vsp_airfoils | `vsp_airfoils/vsp_airfoils/vsp_airfoils.py` | 573 | 26 | 7 | — | GUI/plot, filesystem/path, third-party dependency; external: matplotlib, numpy, scipy |

## Package metadata (distribution names)

The following values come from `setup.py install_requires`; distribution names are intentionally not treated as import names. Conditional imports and transitive dependencies still require runtime review.

- `AvlPy/setup.py`: vsp_airfoils, numpy, scipy, utilities, fortranformat
- `CHARM/setup.py`: utilities, scipy, numpy, matplotlib, pandas, pyautogui, opencv-python, fortranformat, multiprocessing-logging, Pillow
- `PyVSP/setup.py`: pypubsub, vtk >= 8.1.2, wxpython >= 4.0.4, numpy >= 1.9.1
- `degen_geom/setup.py`: utilities, numpy
- `openvsp_config/setup.py`: (none)
- `pyPMARC/setup.py`: numpy, matplotlib, pydantic, f90nml
- `utilities/setup.py`: numpy, matplotlib, scipy
- `vsp_airfoils/setup.py`: numpy>=1.7, matplotlib

## Package-level interpretation

- **AvlPy**: 3 modules; {'A1 — package/dependency; unknown portability': 1, 'C — mixed OpenVSP/environment': 1, 'D — external environment': 1}; OpenVSP symbols: ExecAnalysis, SetIntAnalysisInput, Update, get_instance, parse_degen_geom.
- **CHARM**: 6 modules; {'A0 — pure Python': 1, 'A1 — package/dependency; unknown portability': 2, 'D — external environment': 2, 'C — mixed OpenVSP/environment': 1}; OpenVSP symbols: GetGeomName, GetGeomTypeName, GetNumXSec, GetParmVal, GetXSec, GetXSecParm, GetXSecSurf, get_instance, get_single_propeller_info.
- **PyVSP**: 6 modules; {'A1 — package/dependency; unknown portability': 2, 'C — mixed OpenVSP/environment': 4}; OpenVSP symbols: CompVecPnt01, DOUBLE_DATA, ExecAnalysis, FindContainer, FindContainerParmIDs, FindGeoms, FindParm, GetAllDataNames, GetAnalysisInputDoc, GetAnalysisInputNames, GetAnalysisInputType, GetAndResetUpdateCount, GetDoubleAnalysisInput, GetDoubleResults, GetIntAnalysisInput, GetIntParmVal, GetIntResults, GetNumAnalysisInputData, GetNumData, GetNumMainSurfs, GetParmName, GetParmType, GetParmVal, GetResultsEntryDoc, GetResultsName, GetResultsType, GetStringAnalysisInput, GetStringResults, GetUWTess01, GetVSPVersion, INT_DATA, ListAnalysis, PARM_INT_TYPE, PopupMsg, ReadVSPFile, SET_ALL, STRING_DATA, ScreenGrab, SetAnalysisInputDefaults, SetDoubleAnalysisInput, SetIntAnalysisInput, SetParmVal, SetStringAnalysisInput, StartGUI, StopGUI, Update, UpdateGUI, VEC3D_DATA, VSPCrash, WriteVSPFile.
- **degen_geom**: 3 modules; {'A1 — package/dependency; unknown portability': 2, 'D — external environment': 1}; OpenVSP symbols: none.
- **openvsp**: 6 modules; {'C — mixed OpenVSP/environment': 4, 'D — external environment': 1, 'B — OpenVSP model API': 1}; OpenVSP symbols: ClearVSPModel, DOUBLE_DATA, DOUBLE_MATRIX_DATA, EXPORT_SELIG_AIRFOIL, EXPORT_X3D, ExecAnalysis, ExportFile, FindGeom, GetAllDataNames, GetDoubleMatResults, GetDoubleResults, GetIntResults, GetNumData, GetParmVal, GetResultsName, GetResultsType, GetSetIndex, GetStringResults, GetVec3dResults, INT_DATA, ReadVSPFile, SET_ALL, STRING_DATA, SetAnalysisInputDefaults, SetDoubleAnalysisInput, SetIntAnalysisInput, SetStringAnalysisInput, SetVSP3FileName, Update, VEC3D_DATA, V_UNIT_MACH, get_instance, parse_degen_geom, parse_results_object, set_3d_axis_equal.
- **openvsp_config**: 2 modules; {'A0 — pure Python': 1, 'A1 — package/dependency; unknown portability': 1}; OpenVSP symbols: none.
- **pyPMARC**: 3 modules; {'A1 — package/dependency; unknown portability': 2, 'D — external environment': 1}; OpenVSP symbols: none.
- **utilities**: 11 modules; {'A1 — package/dependency; unknown portability': 6, 'D — external environment': 4, 'A0 — pure Python': 1}; OpenVSP symbols: none.
- **vsp_airfoils**: 3 modules; {'A1 — package/dependency; unknown portability': 2, 'D — external environment': 1}; OpenVSP symbols: none.

## Detected receiver symbols versus experimental facade

Module counts indicate syntactic occurrences in distinct scanned modules, not calls, importance, or a compatibility percentage. This list may include helpers and constants, and may miss names. Presence in the facade is not semantic or overload compatibility.

| Symbol | Modules | In reviewed facade by name? |
| --- | ---: | --- |
| `get_instance` | 6 | no / helper / constant |
| `ExecAnalysis` | 5 | no / helper / constant |
| `SetIntAnalysisInput` | 5 | no / helper / constant |
| `GetParmVal` | 4 | yes (scope limited) |
| `DOUBLE_DATA` | 3 | no / helper / constant |
| `GetStringResults` | 3 | no / helper / constant |
| `INT_DATA` | 3 | no / helper / constant |
| `STRING_DATA` | 3 | no / helper / constant |
| `SetAnalysisInputDefaults` | 3 | no / helper / constant |
| `Update` | 3 | yes (scope limited) |
| `VEC3D_DATA` | 3 | no / helper / constant |
| `parse_results_object` | 3 | no / helper / constant |
| `GetAllDataNames` | 2 | no / helper / constant |
| `GetDoubleResults` | 2 | no / helper / constant |
| `GetIntResults` | 2 | no / helper / constant |
| `GetNumData` | 2 | no / helper / constant |
| `GetResultsName` | 2 | no / helper / constant |
| `GetResultsType` | 2 | no / helper / constant |
| `ReadVSPFile` | 2 | no / helper / constant |
| `SET_ALL` | 2 | no / helper / constant |
| `SetDoubleAnalysisInput` | 2 | no / helper / constant |
| `SetParmVal` | 2 | yes (scope limited) |
| `SetStringAnalysisInput` | 2 | no / helper / constant |
| `parse_degen_geom` | 2 | no / helper / constant |
| `ClearVSPModel` | 1 | no / helper / constant |
| `CompVecPnt01` | 1 | no / helper / constant |
| `DOUBLE_MATRIX_DATA` | 1 | no / helper / constant |
| `EXPORT_SELIG_AIRFOIL` | 1 | no / helper / constant |
| `EXPORT_X3D` | 1 | no / helper / constant |
| `ExportFile` | 1 | no / helper / constant |
| `FindContainer` | 1 | no / helper / constant |
| `FindContainerParmIDs` | 1 | no / helper / constant |
| `FindGeom` | 1 | yes (scope limited) |
| `FindGeoms` | 1 | yes (scope limited) |
| `FindParm` | 1 | no / helper / constant |
| `GetAnalysisInputDoc` | 1 | no / helper / constant |
| `GetAnalysisInputNames` | 1 | no / helper / constant |
| `GetAnalysisInputType` | 1 | no / helper / constant |
| `GetAndResetUpdateCount` | 1 | no / helper / constant |
| `GetDoubleAnalysisInput` | 1 | no / helper / constant |
| `GetDoubleMatResults` | 1 | no / helper / constant |
| `GetGeomName` | 1 | yes (scope limited) |
| `GetGeomTypeName` | 1 | yes (scope limited) |
| `GetIntAnalysisInput` | 1 | no / helper / constant |
| `GetIntParmVal` | 1 | no / helper / constant |
| `GetNumAnalysisInputData` | 1 | no / helper / constant |
| `GetNumMainSurfs` | 1 | no / helper / constant |
| `GetNumXSec` | 1 | no / helper / constant |
| `GetParmName` | 1 | no / helper / constant |
| `GetParmType` | 1 | no / helper / constant |
| `GetResultsEntryDoc` | 1 | no / helper / constant |
| `GetSetIndex` | 1 | no / helper / constant |
| `GetStringAnalysisInput` | 1 | no / helper / constant |
| `GetUWTess01` | 1 | no / helper / constant |
| `GetVSPVersion` | 1 | no / helper / constant |
| `GetVec3dResults` | 1 | no / helper / constant |
| `GetXSec` | 1 | no / helper / constant |
| `GetXSecParm` | 1 | no / helper / constant |
| `GetXSecSurf` | 1 | no / helper / constant |
| `ListAnalysis` | 1 | no / helper / constant |
| `PARM_INT_TYPE` | 1 | no / helper / constant |
| `PopupMsg` | 1 | no / helper / constant |
| `ScreenGrab` | 1 | no / helper / constant |
| `SetVSP3FileName` | 1 | no / helper / constant |
| `StartGUI` | 1 | no / helper / constant |
| `StopGUI` | 1 | no / helper / constant |
| `UpdateGUI` | 1 | no / helper / constant |
| `VSPCrash` | 1 | no / helper / constant |
| `V_UNIT_MACH` | 1 | no / helper / constant |
| `WriteVSPFile` | 1 | no / helper / constant |
| `get_single_propeller_info` | 1 | no / helper / constant |
| `set_3d_axis_equal` | 1 | no / helper / constant |

## Runtime evidence and limitations

See [PYTHON_PACKAGE_SAMPLING.md](PYTHON_PACKAGE_SAMPLING.md) for actual executed cases and test setup. A module tier is not proof of browser compatibility. The original OpenVSP utility module is loaded under an alternate name with the restricted facade and an explicit SET_ALL import shim, not as the native package.

