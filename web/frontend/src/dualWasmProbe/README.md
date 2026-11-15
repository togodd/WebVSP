# Dual WASM diagnostic

This is a fixed proof of concept, not a Python console or MCP server. With a WebVSP page open at `/?dualWasmProbe=1`, the browser console can run `await window.__runDualWasmProbe()`. It loads pinned Pyodide in a worker and runs a built-in Python script; the script reads the current model, creates and selects one wing through a limited message bridge, reads the model again, and checks error propagation. **It modifies the current model.** Each call adds another wing. Do not run it on work you need to preserve.

The page's OpenVSP WASM remains the sole model owner. The Pyodide worker is terminated after completion or failure. A timeout after write dispatch is ambiguous: do not automatically retry. The bridge does not accept caller-provided Python or expose arbitrary OpenVSP methods. A worker is not a security sandbox for untrusted Python.

`npm run dev` and `npm run build` copy the pinned Pyodide runtime from npm into `public/pyodide/`; the generated files are ignored. The runtime assets are served from the same origin. Docker nginx explicitly serves `.mjs` as JavaScript. This probe does not validate VSPAERO, numerical packages, OpenVSP Python binary bindings, or the MCP transport.

To verify against a running deployment with an installed Playwright Chromium:

```sh
CHROMIUM_PATH=/path/to/chrome node scripts/dual-wasm-smoke.mjs
```

Set `WEBVSP_URL` for a different deployment URL. The smoke test checks Python results, matching geometry ID, visible geometry tree, exception propagation, and absence of external network requests.
