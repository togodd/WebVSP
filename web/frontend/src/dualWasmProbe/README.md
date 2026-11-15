# Dual WASM diagnostic

This is a fixed proof of concept, not a Python console or MCP server. With a WebVSP page open at `/?dualWasmProbe=1`, the browser console can run `await window.__runDualWasmProbe()`. It loads pinned Pyodide in a worker and runs the built-in `python/smoke.py`, which imports the bundled `openvsp_wasm` package. The script creates and selects a wing, discovers its parameters, changes its top-level `XForm/X_Rel_Location` by 2, reads it back, and checks error propagation. **It modifies the current model.** Each call adds another wing. Do not run it on work you need to preserve.

The page's OpenVSP WASM remains the sole model owner. The Pyodide worker is terminated after completion or failure. A timeout or transport failure after write dispatch is ambiguous: inspect the model and do not automatically retry. The bridge does not accept caller-provided Python or expose arbitrary OpenVSP methods. A worker is not a security sandbox for untrusted Python. Engine writes use a model-identity guard, not a transaction or protection against concurrent edits in the same model; selection refresh is a separate GUI operation.

## Separate synchronous bridge experiment

With `?dualWasmProbe=1`, create a wing first and run `await window.__runSyncWasmProbe()` in the console. This fixed diagnostic does not modify geometry. It terminates its Pyodide worker on completion or failure. The page and its existing OpenVSP engine must be cross-origin isolated. The original utility function is copied verbatim into `python/sync_native_utility.py` (its imports are not the original module imports); `python3 scripts/test-sync-native.py` checks source drift. A restricted synchronous `openvsp.py` facade is imported by both diagnostics, not the real package or a generic native binding. Invalid parameters and multi-instance requests have different errors. Name lookup supports nonnegative model-order indexes; absent entries return an empty ID.

A fresh 64 KiB SharedArrayBuffer per request carries JSON results; the Python worker waits synchronously for at most 60 seconds, while the page asynchronously dispatches to the existing engine. A separate fixed timeout test uses 20 ms and checks subsequent requests are not contaminated by a late reply. An outer 120-second timer terminates the worker; neither timeout cancels an already-dispatched engine job. The first parameter read scans guarded metadata sequentially; subsequent reads in the same probe cache IDs only, revalidate metadata and read fresh values. This is not an atomic snapshot; same-model structural changes can invalidate the cache.

The file test explicitly sends a fixed Python string to the page, writes a random scratch file in OpenVSP's Emscripten FS, has the OpenVSP engine thread read and replace that file using C stdio, then reads it back to Python and deletes the scratch file after the engine job finishes. This demonstrates a transfer through the engine FS, **not** shared Python `open()`, a mounted filesystem, arbitrary paths, persistence, or native file API compatibility. The fixed scratch operation may finish after worker termination; it is not a general filesystem API. No user model is changed and no user files are accessed. `scripts/sync-wasm-smoke.mjs` tests this in Chromium, including an independent parameter read.

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

The package is bundled into the diagnostic worker's in-memory filesystem; it is not installed globally, published to PyPI, or exposed as an interactive console. Native overloads, generic geometry types, unrestricted OpenVSP API, multiple-model semantics, NumPy utilities, VSPAERO, and solver results are not implemented.

## Migrated wing reference utility

`await get_wing_reference_quantities(wing_name=None, wing_id=None, vsp_instance=None)` is adapted from the native `src/python_api/packages/openvsp/openvsp/utilities.py`. It returns `(TotalArea, TotalSpan, TotalChord)` in that order; ID takes precedence over name, and name selects the first exact match in model order. Only `vsp_instance=None` is supported. Unlike the native utility's current TODO, this adapter rejects non-wing geometries. Missing or ambiguous top-level parameters raise `OpenVSPError`, rather than native error-manager fallback behavior. Values are read sequentially under a model-identity guard, not an atomic snapshot; avoid concurrent edits. The bridge currently scans linkable parameter metadata for each call, so queries can be slow. The diagnostic checks by name only for an initially empty model, avoiding assumptions when names are duplicated.

### Reuse assessment (one function, not the whole API)

Counting nonblank, noncomment executable source lines inside the original function, excluding signature and docstring, gives **12 original lines**. After stripping indentation, 7 lines appear unchanged in the adapted function in the same order (**7/12 = 58.3%**). The five other original lines comprise one instance resolution, one synchronous name lookup, and three synchronous parameter reads; these required adaptation. The adapted function has 15 executable lines, including explicit unsupported-instance handling and a batched bridge interface. This simple lexical measure excludes license, documentation, generated bindings, worker transport, guarded lookups, tests and validation; it is not a measure of project-wide reuse or total effort. The control flow, input precedence, parameter names and return ordering were preserved, but compatibility differences above are real.

## Generating the reviewed subset

`scripts/generate-python-bindings.mjs` uses a deliberately explicit mapping of five bridge-supported operations. It checks their exact C++ declarations in `VSP_Geom_API.h`, checks that SWIG includes the API and enum headers, and checks the complete simple `PARM_TYPE` enumerator sequence in `APIDefines.h`. It generates `_generated.py` with async wrappers and integer constants. This is a narrow declaration check, not a C++ parser or a guarantee of SWIG/native behavioral compatibility. `PARM_TYPE` describes parameter types; it does not imply every type can be written by the bridge.

After reviewing upstream changes, regenerate from `web/frontend` with `node scripts/generate-python-bindings.mjs`, then inspect and commit the generated file. `node scripts/generate-python-bindings.mjs --check` fails if the declarations, reviewed enum sequence, or output drift. Both `npm run dev` and `npm run build` run the check; `VSP_API_DIR` may point to an alternate directory containing the three native source files (Docker supplies it). `python3 scripts/test-python-bindings.py` tests wrapper mappings and errors without the engine. The browser smoke test checks the generated signature and enum against real engine metadata in addition to the modeling workflow.

`npm run dev` and `npm run build` copy the pinned Pyodide runtime from npm into `public/pyodide/`; the generated files are ignored. The runtime assets are served from the same origin. Docker nginx explicitly serves `.mjs` as JavaScript. This probe does not validate VSPAERO, numerical packages, OpenVSP Python binary bindings, or the MCP transport.

To verify against a running deployment with an installed Playwright Chromium:

```sh
CHROMIUM_PATH=/path/to/chrome node scripts/dual-wasm-smoke.mjs
```

Set `WEBVSP_URL` for a different deployment URL. The smoke test checks Python results, matching geometry ID and parameter readback, geometry origin, visible geometry tree, wing reference values against independent page-engine reads, exception propagation, and absence of external network requests. Run `python3 scripts/test-wing-reference.py` for high-level API contract and error tests.
