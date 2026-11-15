# Python package stratified sampling

This report records a fixed browser run of [`sample-python-packages.mjs`](../../scripts/sample-python-packages.mjs) against the deployed WebVSP container. It is evidence about this pinned Pyodide/runtime setup, not a general promise that every package imports or that arbitrary Python can run in the browser.

## Sample strata

| Case | Source | Stratum | Purpose |
| --- | --- | --- | --- |
| `units_full_module` | `src/python_api/packages/utilities/utilities/units.py` | A0/A1 boundary | Pure conversion functions plus the module's imports |
| `numpy_import` | Pyodide package probe | A1 | Check whether NumPy is available in the current worker |
| `transformations_full_module` | `utilities/transformations.py` | A1/local dependency | Test a real NumPy-based utility module |
| `openvsp_utilities_full_module` | `openvsp/openvsp/utilities.py` | B/C | Test whole helper-module importability, not just one extracted function |
| `files_full_module` | `utilities/files.py` | D | Test local file helper transitive dependency |
| `subprocess_echo` | standard-library process operation | D | Confirm process boundary behavior |

The worker starts from the currently deployed Pyodide distribution without `loadPackage` or network package installation. `units.py` is loaded directly rather than through its package initializer. For the other probes the fixture copies the unchanged native `utilities/__init__.py` and `files.py`; it does not provide a native `openvsp` module, so the OpenVSP helper import can only establish its first failure.

## Observed result

Run command:

```text
CHROMIUM_PATH=/home/togo/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome node scripts/sample-python-packages.mjs
```

This baseline run completed with no external browser requests and Python `3.14.2` in Pyodide:

| Case | Status | Evidence |
| --- | --- | --- |
| `units_full_module` | **passed** | `degC2degF(100) = 211.99999999999994`; `gauge2diam(36) = 0.005` |
| `numpy_import` | **blocked_missing_dependency** | `ModuleNotFoundError: No module named 'numpy'` |
| `transformations_full_module` | **blocked_missing_dependency** | `ModuleNotFoundError: No module named 'numpy'` |
| `openvsp_utilities_full_module` | **blocked_missing_dependency** | Native `utilities/__init__.py` imports `files.py`, which fails with `ModuleNotFoundError: No module named 'six'`; the OpenVSP import and later dependencies are not reached |
| `files_full_module` | **blocked_missing_dependency** | `ModuleNotFoundError: No module named 'six'` |
| `subprocess_echo` | **environment_only** | `OSError: [Errno 138] emscripten does not support processes.` |

## Existing shared-model OpenVSP function sample

A later `sync-wasm-smoke.mjs` run loaded the byte-for-byte original `openvsp/openvsp/utilities.py` as `native_openvsp_utilities` with the real original `utilities` package files, NumPy 2.4.6 and six 1.17.0. Build checks compare all bundled source bytes with the original files. The fixed worker injects `SET_ALL=0` into the restricted `openvsp` facade before import, matching the native enum; the facade is a module, not the native package, so this is **not** `import openvsp.utilities` or native package initialization. The test confirms the module resolves `vsp_module` to the facade and `RunManager` to the genuine utilities package, executes NumPy and creates an identity `TransMatrix` from the unchanged original transformations module.

For an existing wing the imported original function returned `[45, 18, 2.5]` both by ID and by name, matching independent engine reads; the test blocks external requests. It also confirms the diagnostic rejects missing and tampered NumPy wheel responses. It exercises one function and one model/parameter combination, not all functions in the imported module.

## Interpretation

- The unchanged `units.py`, `transformations.py`, `utilities/files.py`, and `openvsp/utilities.py` sources can now import in the fixed worker when the exact staged NumPy and six wheels are loaded.
- The original wing reference helper's control flow and API calls were executed against the page's shared model, with independent readback agreement.
- Importability is a separate gate from function portability: loading a module does not prove its export, results, analysis, plotting, file, or process paths are compatible.
- The import required an explicit `SET_ALL=0` shim because the restricted facade does not yet expose the full native constants surface. This is evidence of a controlled compatibility seam, not native package equivalence.
- Process-running code is not portable to the browser's Pyodide environment. Existing OpenVSP process integration is a separate page-mediated worker mechanism, not Python `subprocess` reuse.

## Not yet tested

This sample does not claim support for CHARM, AVL, PMARC, PyVSP GUI panels, generated `openvsp.vsp` bindings, result objects, analysis APIs, file dialogs, plotting, or VSPAERO subprocess orchestration. The static audit also needs a future package-metadata/transitive-import pass; its current counts are triage data, not a reuse percentage. Those require package metadata/transitive-import review and additional fixtures. In particular, the current synchronous facade covers only a small subset of required OpenVSP symbols and does not cover overloads such as the parameter-ID form of `GetParmVal`.
