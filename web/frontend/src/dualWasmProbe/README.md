# Dual WASM diagnostic

This is a fixed proof of concept, not a Python console or MCP server. With a WebVSP page open at `/?dualWasmProbe=1`, the browser console can run `await window.__runDualWasmProbe()`. It loads pinned Pyodide in a worker and runs the built-in `python/smoke.py`, which imports the bundled `openvsp_wasm` package. The script creates and selects a wing, discovers its parameters, changes its top-level `XForm/X_Rel_Location` by 2, reads it back, and checks error propagation. **It modifies the current model.** Each call adds another wing. Do not run it on work you need to preserve.

The page's OpenVSP WASM remains the sole model owner. The Pyodide worker is terminated after completion or failure. A timeout or transport failure after write dispatch is ambiguous: inspect the model and do not automatically retry. The bridge does not accept caller-provided Python or expose arbitrary OpenVSP methods. A worker is not a security sandbox for untrusted Python. Engine writes use a model-identity guard, not a transaction or protection against concurrent edits in the same model; selection refresh is a separate GUI operation.

## Separate synchronous bridge experiment

With `?dualWasmProbe=1`, create a wing first and run `await window.__runSyncWasmProbe()` in the console. This fixed diagnostic does not modify geometry. It terminates its Pyodide worker on completion or failure. The page and its existing OpenVSP engine must be cross-origin isolated. The fixed read diagnostic loads the byte-identical original `openvsp/utilities.py` under the name `native_openvsp_utilities`, alongside the original `utilities` package files and same-origin NumPy/six wheels. It injects native `SET_ALL=0` into the facade solely to satisfy default arguments at module import. `node scripts/check-native-modules.mjs` checks source drift. A restricted synchronous `openvsp.py` facade is imported by both diagnostics, not the real package or a generic native binding; `import openvsp.utilities` and full native package initialization are not implemented. Invalid parameters and multi-instance requests have different errors. Name lookup supports nonnegative model-order indexes; absent entries return an empty ID.

A fresh 64 KiB SharedArrayBuffer per request carries JSON results; the Python worker waits synchronously for at most 60 seconds, while the page asynchronously dispatches to the existing engine. Oversized responses become a structured `RESPONSE_TOO_LARGE` error; the cap is not silently increased. A separate fixed timeout test uses 20 ms and checks subsequent requests are not contaminated by a late reply. An outer 120-second timer terminates the worker; neither timeout cancels an already-dispatched engine job. The first parameter read scans guarded metadata sequentially; parameter-ID reads are owner-scoped and revalidated by the engine. This is not an atomic snapshot; same-model structural changes can invalidate IDs.

The file test explicitly sends a fixed Python string to the page, writes a random scratch file in OpenVSP's Emscripten FS, has the OpenVSP engine thread read and replace that file using C stdio, then reads it back to Python and deletes the scratch file after the engine job finishes. This demonstrates a transfer through the engine FS, **not** shared Python `open()`, a mounted filesystem, arbitrary paths, persistence, or native file API compatibility. The fixed scratch operation may finish after worker termination; it is not a general filesystem API. No user model is changed and no user files are accessed. `scripts/sync-wasm-smoke.mjs` tests this in Chromium, including an independent parameter read.

## P0 typed Results Manager fixture

The fixed read diagnostic also opens a one-shot opaque ResultsMgr lease and runs the unchanged original `parse_results_object` against it. The engine creates fixed namedtuple-safe fields for int, string, double, double matrix, and vec3d, deep-copies typed getter results on the engine thread, and deletes only its own result. The lease is explicitly closed after parsing and has a 30-second TTL for worker loss. This validates the parser and transport contract only; arbitrary live result IDs, unrestricted Results Manager calls, and real analysis side effects are not exposed.

## In-process mode: native-shaped Python on the page model

`window.__runPython(code)` (with `?dualWasmProbe=1`) runs Python against the **live page
model**, the way a desktop script does. The worker installs `openvsp` as a package whose
calls go straight to the page's engine thread: `AddGeom`, `SetParmVal(geom, name, group, value)`,
`GetParmVal`, `Update`, `FindGeoms`, `FindGeom`, `GetGeomName`, `GetGeomTypeName`,
`GetGeomParmIDs`, `SetAnalysisInputDefaults`, `SetIntAnalysisInput`, `ExecAnalysis`,
`GetAllResultsIDs`, `GetAllDataNames`, `GetResultsName`, `GetNumData`, `GetResultsType`,
`GetIntResults`, `GetDoubleResults`, `GetStringResults`, `GetDoubleMatResults`,
`GetVec3dResults` and `parse_results_object`. The original `degen_geom_parse` and
`surface_patches` helpers run unmodified on those results, so existing scripts are the
target, not a new API.

```js
await window.__runPython(`
import openvsp as vsp, degen_geom_parse
w = vsp.AddGeom("WING")
vsp.SetParmVal(w, "TotalSpan", "WingGeom", 12.0)
vsp.Update()
root = vsp.ExecAnalysis("DegenGeom")
len(degen_geom_parse.parse_degen_geom(root))
`)
```

The Python console displays per-run bridge call count, cumulative `Atomics.wait` time,
and response bytes alongside total wall time. Bridge wait includes engine queueing,
analysis execution and page delivery: it is **not** a measurement of polling overhead
or Python CPU. The first run's total can also include interpreter initialization; use
subsequent runs for warm measurements. Counters reset per run and include failed calls.
The `profile` object returned by the internal console session also contains per-operation
counts, wait time and bytes.

Analysis results **stay in the page's ResultsManager**, as on the desktop: nothing is
serialized away, and later calls can read them.

This mode deliberately gives up the protections the isolated diagnostic has: an analysis
out-of-memory or assertion takes the whole engine session — and unsaved edits — with it;
the engine thread is busy while an analysis runs, so the GUI mirror and 3D view stop
updating and clicks are ignored; and there is no cancellation. It is arbitrary Python in
your own page, not a security boundary. Analyses always cover the whole model with file
output and mode application disabled. Large result fields use an 8 MiB response buffer;
anything beyond that fails with a clear error instead of being truncated.

## P1 current-model analysis

The page has a product entry: the top bar's **Geometry analysis** button opens a
floating window with the supported-range summary, an option per analysis, stage progress,
the result table (per geometry: type, objects, patches) and the failure reason. The same
work is available from the console as `await window.__runP1CurrentModelProbe()`.

`await window.__runP1CurrentModelProbe()` analyzes a **serialized copy** of the active
model in the disposable instance. The page model is never passed to the analysis. The
engine encodes it to memory with `EncodeXml(SET_ALL)` — no file is written and the
filename is not changed — and the isolated instance reads that text into its own fresh
vehicle.

Supported subset: `POD`, `FUSELAGE`, `WING`, `STACK`, `BLANK`, `PROP`, top-level only
(no attached parent). Everything else — meshes, NGon meshes, human/wire/clone geometry,
custom geometry, attached geometry, empty models — is rejected before serialization.
Links, control surfaces and point-set airfoils inside those types are preserved.

Equivalence is checked, not assumed: the engine hashes an ID-free canonical fingerprint
of the source model (geometry tree, per-geom parameters keyed by display group/name,
subsurface counts), the isolated instance hashes the same way after decoding, and the
page refuses to return analysis results when the two hashes differ. The copy is also
required to match across the two analyses.

Measured side effects of encoding, from the Phase 1 spike: parameter values, update
count, filename, selection and results are unchanged; the page watcher emits no
`model_changed`. The global parm-change counter rises (50-64 per model), which only
invalidates `LinkMgr`'s metadata caches, and `ParmMgr`'s dirty flag becomes true, which
only triggers linkable-parameter metadata rebuilds.

Limits: the model text is capped at 4 MiB and the result snapshot at 8 MiB. Each
analysis still loads a fresh WASM instance and a fresh Pyodide, so a run takes tens of
seconds on a large model. `ReadVSPFile` appends to a vehicle, so the isolated instance
must be fresh — never reuse it. A model whose analysis output would exceed a budget
fails rather than being truncated; peak native analysis memory and CPU remain only
loosely bounded by the 1 GiB WASM maximum and the host timeout.

## P1 isolated analysis diagnostic

With `?dualWasmProbe=1`, run `await window.__runP1AnalysisProbe()` in the browser console. This is a fixed diagnostic, not a general analysis API. Each analysis executes on a separately instantiated disposable WebAssembly module and its own worker, memory, OpenVSP global managers and filesystem; it creates a fixed default `WING` or `PROP` and **does not read or analyze the active page model**. It runs both real `DegenGeom` and `SurfacePatches` with `SET_ALL`, with DegenGeom mode and CSV/M output explicitly disabled. Separate instances are used for the two analyses, so their geom and results IDs are unrelated. The original `parse_results_object`, `parse_degen_geom` and `export_surface_patches` run unchanged against validated, in-memory snapshots. The adapter is narrow and snapshot-backed: it does not provide general `ExecAnalysis`, support arbitrary models or sets, or establish native SWIG parity.

Success snapshots are capped at 8 MiB, 4096 results, 100000 indexed fields and 500000 values; non-finite numbers and unsupported result types fail, rather than being truncated. These are post-analysis snapshot budgets, **not** guaranteed limits on CPU or peak memory during native analysis. The fixed models narrow but do not eliminate resource exhaustion; the separate module has a 1 GiB WebAssembly memory maximum. The host runs only one P1 probe at a time, times out each analysis or Python phase after 120 seconds, and terminates its worker. Normal native success explicitly removes results added during that single-threaded run before returning; cleanup failure prevents a success response. On exceptions cleanup is best-effort, and allocation failure can prevent it altogether: abnormal cleanup relies on destroying the disposable instance, not on rollback of the live page engine. Browser and OS process resource limits still apply. Closing the worker does not claim transactional cancellation of any work outside that isolated instance.

Build with `web/wasm/build_wasm.ps1` (default target includes `vsp_p1_analysis`), then build the frontend so the matching JS and WASM are copied together. From the frontend directory, run `python3 scripts/test-p1-snapshot.py` (host NumPy and six required), `node scripts/p1-native-smoke.mjs` (also run by Pages CI), and `CHROMIUM_PATH=/path/to/chrome WEBVSP_URL=http://127.0.0.1:4173/ node scripts/p1-wasm-smoke.mjs` against an already served production build. The browser smoke injects a program-import failure and checks worker termination and subsequent recovery. It also initializes the real WASM module and injects a synthetic busy loop into the `callMain` wrapper, then accelerates the 120-second timer to exercise timeout and termination of a busy worker. This does not wait 120 seconds or test termination during native OpenVSP computation. It uses a disposable page-model wing and checks its before/after model snapshot; this is not proof that arbitrary models or unrelated external state are unchanged. The native smoke checks limits on observed output only; the production module does not export FS, so its filesystem check is skipped. The separate `p1_filesystem_test` build exposes FS only for tests and verifies its isolated working directory before and after the four fixed analyses and invalid requests; this does not inspect every virtual filesystem path or prove behavior of a differently linked binary. The separately built white-box `p1_snapshot_test` exercises the production serializer's exact byte, value, array, result and field boundaries and non-finite values; its field/result-count tests reuse one real result ID rather than generating thousands of unique results, and it does not force the full analysis to exhaust a budget. A test-only manager proxy also injects result-enumeration and deletion failures into the real entry point, checking that cleanup failures do not publish success and the destructor does not replace the original error. Browser process memory reclamation has not been empirically established. No desktop native differential comparison has been performed.

## Broader native API analysis

See [PYTHON_API_ROADMAP.md](PYTHON_API_ROADMAP.md) for the native binding and package-workflow analysis, limitations, safety findings and phased implementation plan; [NATIVE_API_INVENTORY.md](NATIVE_API_INVENTORY.md) is the regenerable textual declaration and package-use inventory. These are analysis artifacts, not an authorization list or proof of Python compatibility.

## Reviewed synchronous API inventory

`sync-api.json` is the reviewable source for the existing synchronous API wrappers, their wire arguments and basic types, write classification, epoch expectations, native overload, scope, errors and test coverage. `node scripts/generate-sync-api.mjs` verifies each exact reviewed overload in `VSP_Geom_API.h` and the SWIG header inclusion, then produces the Python wrapper, TypeScript metadata and `SYNC_API.md` inventory. `--check` verifies all three outputs without changing them; dev and production builds run it. Set `VSP_API_DIR` to use an alternate directory containing the header and SWIG file. The check verifies exact selected declarations, not all overloads or behavioral equivalence; any native default, scope or mapping change still requires human review.

The page applies generated basic argument-type metadata and write classification, while the operation handlers, epoch enforcement, actual model mutations, result validation and diagnostic-only operations remain handwritten and must be independently reviewed and tested. Adding an entry alone neither implements an engine handler nor makes an operation safe. No new OpenVSP API or arbitrary Python execution is exposed by this generator. The generated table is a review aid rather than a security boundary or a complete native compatibility matrix.

## Synchronous modeling diagnostic and compatibility

With `?dualWasmProbe=1`, `await window.__runSyncModelingProbe()` runs a fixed script in a new worker. **Each run creates two wings, renames both, deletes one, and changes the remaining wing's X position by 2 in the current model. Use a disposable model.** It does not accept arbitrary Python. `scripts/sync-modeling-smoke.mjs` tests the script, independent origin readback, GUI display, and a real in-flight timeout simulation; `python3 scripts/test-sync-facade.py` tests signatures, dispatch and errors.

| Facade API | Experimental scope and divergence |
| --- | --- |
| `AddGeom(type, parent='')` | Only `WING` with empty parent. Engine updates immediately and diagnostic selects the new geom; unlike native creation, selection and update are additional effects. |
| `FindGeom(name, index)` | Exact name in model order, supports nonnegative indexes; absent or negative index returns an empty ID. |
| `FindGeoms()`, `GetGeomName(id)`, `GetGeomTypeName(id)` | Current model snapshot, with live geometry IDs in model order; not an atomic snapshot across multiple calls. |
| `SetGeomName(id, name)` | Current model geometries only; nonempty name of at most 256 UTF-8 bytes, non-automatic names only. Calls native rename and verifies readback. |
| `DeleteGeom(id)` | Current model geometry only, fixed native clone mode `CLONE_DELETE_LEAVE_EMPTY`; deletion can affect descendants and clone placeholders, and invokes update. Optional native clone mode is not supported. |
| `GetParmVal(geom_id, name, group)` | Only three wing reference values and top-level `XForm/X_Rel_Location`; no parm-ID overload. |
| `SetParmVal(geom_id, name, group, value)` | Only top-level wing `XForm/X_Rel_Location`. Uses the guarded validated `SetParmValUpdate` path, **not** native deferred `SetParmVal`; rejects out-of-range and inactive values rather than matching native clamp/error behavior. |
| `Update(update_managers=True)` | Only `True`, an actual guarded engine `vsp::Update(true)` call. Earlier AddGeom and SetParmVal already update, so ordering and side effects are not native-equivalent. |
| `get_instance(None)` | Only the current model; no multi-instance support. |

Failures become `OpenVSPError` with `outcome` (`not_written`, `unknown`, or `different`) where known, not the native error-manager contract. A `not_written` error applies only to that individual call, **not** previous successful writes. Selection happens after creation; its failure does not undo creation. Timeouts cannot cancel submitted engine work; the facade reports write outcomes as unknown and the session refuses subsequent calls after an actual timeout. No automatic retry, rollback or same-model concurrency isolation is provided. The scratch-file roundtrip is the same fixed explicit experiment described above, not real model persistence or a general file bridge. `openvsp.py` is bundled only in these fixed worker diagnostics, not installed as a public package. The host test also checks native-style signatures and maps bridge timeout errors to `unknown` for writes.

## Python subset and compatibility

These functions are async, require `await`, and are not a drop-in replacement for native synchronous `openvsp`. Generated bindings `FindGeoms`, `GetGeomName`, `GetGeomTypeName`, `AddGeom`, and `GetGeomParmIDs` follow the corresponding native names and parameter names in a limited form. `AddGeom(type, parent='')` currently accepts only a top-level `WING`; it updates the model immediately and the diagnostic selects it. The prior experimental `geom_type=` keyword is replaced by `type=` to match the native declaration; positional use is unchanged. Lists and errors also differ from SWIG/native behavior. `GetGeomParm` and `GetGeomParmVal` are WebVSP-specific owner-scoped metadata/value readers; `SetGeomParmVal` is a WebVSP-specific validated write-and-update with readback, not native `SetParmVal`. Parameter discovery includes nested containers; check `container` along with `name` and `group`. Values can be limited or inactive. Engine errors become `OpenVSPError`, with `outcome`, `actual` and `code` where available. `not_written` means that particular write was rejected; it does not roll back earlier operations.

The fixed original helper modules are bundled into the diagnostic worker's in-memory filesystem; they are not installed globally, published to PyPI, or exposed as an interactive console. The exact NumPy and six wheels are staged as same-origin diagnostic dependencies, not a general Python package mirror. Native overloads, generic geometry types, unrestricted OpenVSP API, multiple-model semantics, VSPAERO, and solver results are not implemented.

## Migrated wing reference utility

`await get_wing_reference_quantities(wing_name=None, wing_id=None, vsp_instance=None)` is adapted from the native `src/python_api/packages/openvsp/openvsp/utilities.py`. It returns `(TotalArea, TotalSpan, TotalChord)` in that order; ID takes precedence over name, and name selects the first exact match in model order. Only `vsp_instance=None` is supported. Unlike the native utility's current TODO, this adapter rejects non-wing geometries. Missing or ambiguous top-level parameters raise `OpenVSPError`, rather than native error-manager fallback behavior. Values are read sequentially under a model-identity guard, not an atomic snapshot; avoid concurrent edits. The bridge currently scans linkable parameter metadata for each call, so queries can be slow. The diagnostic checks by name only for an initially empty model, avoiding assumptions when names are duplicated.

### Reuse assessment (one function, not the whole API)

Counting nonblank, noncomment executable source lines inside the original function, excluding signature and docstring, gives **12 original lines**. After stripping indentation, 7 lines appear unchanged in the adapted function in the same order (**7/12 = 58.3%**). The five other original lines comprise one instance resolution, one synchronous name lookup, and three synchronous parameter reads; these required adaptation. The adapted function has 15 executable lines, including explicit unsupported-instance handling and a batched bridge interface. This simple lexical measure excludes license, documentation, generated bindings, worker transport, guarded lookups, tests and validation; it is not a measure of project-wide reuse or total effort. The control flow, input precedence, parameter names and return ordering were preserved, but compatibility differences above are real.

## Generating the reviewed subset

`scripts/generate-python-bindings.mjs` uses a deliberately explicit mapping of five bridge-supported operations. It checks their exact C++ declarations in `VSP_Geom_API.h`, checks that SWIG includes the API and enum headers, and checks the complete simple `PARM_TYPE` enumerator sequence in `APIDefines.h`. It generates `_generated.py` with async wrappers and integer constants. This is a narrow declaration check, not a C++ parser or a guarantee of SWIG/native behavioral compatibility. `PARM_TYPE` describes parameter types; it does not imply every type can be written by the bridge.

After reviewing upstream changes, regenerate from `web/frontend` with `node scripts/generate-python-bindings.mjs`, then inspect and commit the generated file. `node scripts/generate-python-bindings.mjs --check` fails if the declarations, reviewed enum sequence, or output drift. Both `npm run dev` and `npm run build` run the check; `VSP_API_DIR` may point to an alternate directory containing the three native source files (Docker supplies it). `python3 scripts/test-python-bindings.py` tests wrapper mappings and errors without the engine. The browser smoke test checks the generated signature and enum against real engine metadata in addition to the modeling workflow.

`npm run dev` and `npm run build` copy pinned Pyodide core assets and the vendored NumPy 2.4.6/six 1.17.0 wheels into ignored `public/pyodide/`, verifying the wheels against reviewed SHA-256 values and the Pyodide lock. The read diagnostic loads those packages from the same origin with integrity checking; it verifies a basic NumPy calculation and identity matrix, not numerical equivalence across the libraries. Docker nginx explicitly serves `.mjs` as JavaScript. This probe does not validate VSPAERO, OpenVSP Python binary bindings, or the MCP transport.

To verify against a running deployment with an installed Playwright Chromium:

```sh
CHROMIUM_PATH=/path/to/chrome node scripts/dual-wasm-smoke.mjs
```

Set `WEBVSP_URL` for a different deployment URL. The smoke test checks Python results, matching geometry ID and parameter readback, geometry origin, visible geometry tree, wing reference values against independent page-engine reads, exception propagation, and absence of external network requests. Run `python3 scripts/test-wing-reference.py` for high-level API contract and error tests.
