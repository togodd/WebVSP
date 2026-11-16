# Live binary browser integration check

This test uses a **disposable** engine and browser profile. It creates a ResultsMgr fixture and exercises the real WASM writer, browser binary transport and Pyodide getters/parser. It requires a development frontend (`testCall` is absent from production), local Pyodide assets, a cross-origin-isolated origin and Playwright Chromium. The test fails rather than falling back to mock data if the fixture is missing.

After building the ordinary WASM dependencies, configure a **separate** OpenVSP build directory using the same Emscripten toolchain, library path, FLTK and other flags as `web/wasm/build_wasm.ps1`, but set `-DWEBVSP_PRODUCTION_BUILD=OFF -DWEBVSP_LIVE_BINARY_TEST=ON`. Build target `vsp_wasm`, then copy its `wasm_engine/vsp.js` and `wasm_engine/vsp.wasm` to an isolated frontend's `public/wasm/`. Do not deploy these test artifacts. The normal build script explicitly sets production ON; rerunning it resets production and must not be used to create this fixture build. CMake rejects production + fixture together, as does the source-level guard.

From `web/frontend`, install dependencies and prepare local Pyodide assets as documented in `src/dualWasmProbe/README.md`, run `npm run dev` on an isolated port, then in another terminal:

```sh
WEBVSP_URL=http://127.0.0.1:5173/ CHROMIUM_PATH=/path/to/chromium node scripts/live-binary-browser-check.mjs
```

Omit `CHROMIUM_PATH` if Playwright's Chromium is installed. The test checks empty/4095/4096/4097/8193 doubles, NaN and signed infinities across chunk boundaries, ragged and empty matrices, integers, vec3d and the VRO1 batch path; it records actual Pyodide bridge calls to verify offsets and that the aggregate parser did not silently fall back. Browser/network/Python failures are fatal. Restore normal engine assets after testing.
