# Dual WASM diagnostic

This is a fixed proof of concept, not a Python console or MCP server. With a WebVSP page open at `/?dualWasmProbe=1`, the browser console can run `await window.__runDualWasmProbe()`. It loads pinned Pyodide in a worker and runs the built-in `python/smoke.py`, which imports the bundled `openvsp_wasm` package. The script creates and selects a wing, discovers its parameters, changes its top-level `XForm/X_Rel_Location` by 2, reads it back, and checks error propagation. **It modifies the current model.** Each call adds another wing. Do not run it on work you need to preserve.

The page's OpenVSP WASM remains the sole model owner. The Pyodide worker is terminated after completion or failure. A timeout or transport failure after write dispatch is ambiguous: inspect the model and do not automatically retry. The bridge does not accept caller-provided Python or expose arbitrary OpenVSP methods. A worker is not a security sandbox for untrusted Python. Engine writes use a model-identity guard, not a transaction or protection against concurrent edits in the same model; selection refresh is a separate GUI operation.

## Python subset and compatibility

These functions are async, require `await`, and are not a drop-in replacement for native synchronous `openvsp`. Generated bindings `FindGeoms`, `GetGeomName`, `GetGeomTypeName`, `AddGeom`, and `GetGeomParmIDs` follow the corresponding native names and parameter names in a limited form. `AddGeom(type, parent='')` currently accepts only a top-level `WING`; it updates the model immediately and the diagnostic selects it. The prior experimental `geom_type=` keyword is replaced by `type=` to match the native declaration; positional use is unchanged. Lists and errors also differ from SWIG/native behavior. `GetGeomParm` and `GetGeomParmVal` are WebVSP-specific owner-scoped metadata/value readers; `SetGeomParmVal` is a WebVSP-specific validated write-and-update with readback, not native `SetParmVal`. Parameter discovery includes nested containers; check `container` along with `name` and `group`. Values can be limited or inactive. Engine errors become `OpenVSPError`, with `outcome`, `actual` and `code` where available. `not_written` means that particular write was rejected; it does not roll back earlier operations.

The package is bundled into the diagnostic worker's in-memory filesystem; it is not installed globally, published to PyPI, or exposed as an interactive console. Native overloads, generic geometry types, unrestricted OpenVSP API, multiple-model semantics, NumPy utilities, VSPAERO, and solver results are not implemented.

## Generating the reviewed subset

`scripts/generate-python-bindings.mjs` uses a deliberately explicit mapping of five bridge-supported operations. It checks their exact C++ declarations in `VSP_Geom_API.h`, checks that SWIG includes the API and enum headers, and checks the complete simple `PARM_TYPE` enumerator sequence in `APIDefines.h`. It generates `_generated.py` with async wrappers and integer constants. This is a narrow declaration check, not a C++ parser or a guarantee of SWIG/native behavioral compatibility. `PARM_TYPE` describes parameter types; it does not imply every type can be written by the bridge.

After reviewing upstream changes, regenerate from `web/frontend` with `node scripts/generate-python-bindings.mjs`, then inspect and commit the generated file. `node scripts/generate-python-bindings.mjs --check` fails if the declarations, reviewed enum sequence, or output drift. Both `npm run dev` and `npm run build` run the check; `VSP_API_DIR` may point to an alternate directory containing the three native source files (Docker supplies it). `python3 scripts/test-python-bindings.py` tests wrapper mappings and errors without the engine. The browser smoke test checks the generated signature and enum against real engine metadata in addition to the modeling workflow.

`npm run dev` and `npm run build` copy the pinned Pyodide runtime from npm into `public/pyodide/`; the generated files are ignored. The runtime assets are served from the same origin. Docker nginx explicitly serves `.mjs` as JavaScript. This probe does not validate VSPAERO, numerical packages, OpenVSP Python binary bindings, or the MCP transport.

To verify against a running deployment with an installed Playwright Chromium:

```sh
CHROMIUM_PATH=/path/to/chrome node scripts/dual-wasm-smoke.mjs
```

Set `WEBVSP_URL` for a different deployment URL. The smoke test checks Python results, matching geometry ID and parameter readback, geometry origin, visible geometry tree, exception propagation, and absence of external network requests.
