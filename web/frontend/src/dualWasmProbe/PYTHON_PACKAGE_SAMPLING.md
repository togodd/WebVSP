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

The run completed with no external browser requests and Python `3.14.2` in Pyodide:

| Case | Status | Evidence |
| --- | --- | --- |
| `units_full_module` | **passed** | `degC2degF(100) = 211.99999999999994`; `gauge2diam(36) = 0.005` |
| `numpy_import` | **blocked_missing_dependency** | `ModuleNotFoundError: No module named 'numpy'` |
| `transformations_full_module` | **blocked_missing_dependency** | `ModuleNotFoundError: No module named 'numpy'` |
| `openvsp_utilities_full_module` | **blocked_missing_dependency** | Native `utilities/__init__.py` imports `files.py`, which fails with `ModuleNotFoundError: No module named 'six'`; the OpenVSP import and later dependencies are not reached |
| `files_full_module` | **blocked_missing_dependency** | `ModuleNotFoundError: No module named 'six'` |
| `subprocess_echo` | **environment_only** | `OSError: [Errno 138] emscripten does not support processes.` |

## Existing shared-model OpenVSP function sample

The separate `sync-wasm-smoke.mjs` run on the same deployed app passed with zero external requests. It executed the unchanged `get_wing_reference_quantities` function, whose source is checked against `openvsp/openvsp/utilities.py` by `test-sync-native.py`. With an existing wing, calls by ID and by name both returned `[45, 18, 2.5]`, equal to independent engine parameter reads. This is function extraction with a custom restricted facade, **not** a successful import of the full original module or native package. It samples one OpenVSP-using function and one model/parameter combination.

## Interpretation

- A small, dependency-free subset of package code is directly reusable: the conversion functions in `units.py` execute unchanged.
- Importability is a separate gate from function portability. The whole `transformations.py` module is blocked before its functions run because NumPy is not available in the current worker package setup.
- The OpenVSP utility module cannot be treated as reusable merely because the extracted `get_wing_reference_quantities` function passed earlier. Its module-level dependency graph includes `utilities.RunManager`, plotting/numeric helpers, and many OpenVSP APIs.
- `files.py` demonstrates that a standard-looking helper can be blocked by a non-stdlib dependency (`six`) before use.
- Process-running code is not portable to the browser's Pyodide environment. Existing OpenVSP process integration is a separate page-mediated worker mechanism, not Python `subprocess` reuse.

## Not yet tested

This sample does not claim support for CHARM, AVL, PMARC, PyVSP GUI panels, generated `openvsp.vsp` bindings, result objects, analysis APIs, file dialogs, plotting, or VSPAERO subprocess orchestration. The static audit also needs a future package-metadata/transitive-import pass; its current counts are triage data, not a reuse percentage. Those require package metadata/transitive-import review and additional fixtures. In particular, the current synchronous facade covers only a small subset of required OpenVSP symbols and does not cover overloads such as the parameter-ID form of `GetParmVal`.
