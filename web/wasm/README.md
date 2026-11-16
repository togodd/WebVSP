# WebVSP engine: OpenVSP in WebAssembly

OpenVSP, its FLTK GUI and VSPAERO compiled to WebAssembly, running inside the browser tab.
OpenVSP's own windows, menus and dialogs are mirrored into the page; the 3D view is the page's
own. Nothing is installed and nothing runs outside the browser.

## Build

You don't need to build it to deploy: pushing to `main` builds it in CI
(`.github/workflows/pages.yml`). To build it yourself, for local development:

Needs the Emscripten SDK (version 6.0.12) and CMake 4.4.4, as CI uses, and Ninja next to the repo (paths are
parameters of the script; an emsdk environment that's already set up, and ninja or ccache on
PATH, are used as they are), plus Node LTS for the page. The script also runs on Linux and
macOS with PowerShell 7 (`pwsh`):

```powershell
# once: tools (outside the repo)
git clone https://github.com/emscripten-core/emsdk ..\emsdk; ..\emsdk\emsdk.bat install 6.0.12; ..\emsdk\emsdk.bat activate 6.0.12
python -m pip install ninja --target ..\tools\ninja

web\wasm\build_wasm.ps1    # libraries, FLTK, OpenVSP, VSPAERO -> web\frontend\public\wasm\
web\wasm\serve.ps1 -Open   # builds the page, serves http://localhost:4173/
```

| Option | What it rebuilds |
|---|---|
| `-Stage all` (default) | Everything: third-party libraries, FLTK, OpenVSP and its programs. |
| `-Stage libs` | Third-party libraries only. |
| `-Stage fltk` | FLTK only (with the headless platform). |
| `-Stage vsp` | OpenVSP only: what you need after changing C++ in `src/`. |
| `-Targets vsp_wasm,vsp_p1_analysis,vspaero,vsploads` | Which programs to build (default all four). `vsp_wasm` is the page engine; `vsp_p1_analysis` is the disposable fixed-model P1 diagnostic. |

The first full build takes a while; later ones are incremental. The output
(`vsp.js/.wasm`, `vsp_p1_analysis.js/.wasm`, `vspaero.js/.wasm`, `vsploads.js/.wasm`) is gitignored.

With an initialized Emscripten environment and an existing VSP build tree, the P1
serializer's test-only, non-installed target can be built and run separately:

```sh
cmake --build build/vsp-wasm --target p1_snapshot_test p1_filesystem_test
node build/vsp-wasm/wasm_engine/p1_snapshot_test.js
node web/frontend/scripts/p1-native-smoke.mjs build/vsp-wasm/wasm_engine/p1_filesystem_test.js
```

This white-box test includes the production serializer implementation directly; it is not
part of the default or distributed WebAssembly programs.

During development, `cd web\frontend; npm run dev` serves the page with hot reload at
http://localhost:5173/ using the same output. Hard-refresh after rebuilding the engine.

## Production compile guard

`build_wasm.ps1` sets `WEBVSP_PRODUCTION_BUILD=ON`. This rejects the test-hook
options and checks a C++ translation unit with the Release compiler flags on every
configure, including after cached flag changes. A failed compile also fails closed.
The option defaults to OFF for isolated test builds. Production definitions on
`geom_core` and `vsp_wasm` additionally reject either test macro in `Parm.cpp` and
`engine.cpp` at compile time, including target-specific definitions.

Run the independent configuration tests (CMake 3.24+ and a C++ compiler):

```sh
cmake -P web/wasm/tests/production_guard/run.cmake
```

The test creates a uniquely named `webvsp-guard-test-*` directory in the current
directory and leaves it for inspection; remove it yourself when finished. It tests
normal, option, cached and Release flags, forced headers, and reconfiguration. Real
source preprocessor guard checks run when a GCC-compatible `c++` driver is found.

This is a build-time safeguard, not a security boundary: the configure probe sees
compiler/toolchain and Release flags, not later target-specific flags, other build
configurations, or macros introduced after the source guards. The source guards
cover the two files above only; deliberately altering/undefining the production
macro, changing sources or build rules, or reusing old artifacts can bypass them.
Use a clean, trusted production build configuration and toolchain.

## Test-only Parm reentry hook

`WEBVSP_PARM_REENTRY_TEST` is OFF by default. When enabled it compiles a one-shot
`Parm::SetFromDevice` hook into both `geom_core` and `vsp_wasm`, and adds the
`parm_reentry_test` target. **Use a separate, disposable CMake build directory** with
this option enabled; never deploy its engine or reuse its artifacts for production. CMake
caches options, and `geom_core` is shared by targets in a build tree. A normal production
build must use its own build tree with the option OFF. After configuring the isolated tree
with the same Emscripten and library settings as the normal build, use
`cmake --build <test-build> --target parm_reentry_test vsp_wasm`, then run
`node <test-build>/wasm_engine/parm_reentry_test.js` (with the Node threading flags required
by the installed SDK). The hook is owner-thread-only, and an armed target and context must
remain alive until it fires or is cleared. It applies to `Parm::SetFromDevice` itself, not
`FractionParm`'s independent override.

The fixed `scriptSetterGcProbe` engine operation additionally requires
`WEBVSP_SCRIPT_GUARD_TEST` (for example in the isolated tree's C++ flags) as well
as `WEBVSP_PARM_REENTRY_TEST=ON`. It runs a single guarded fixed parameter write
and forces script-cycle GC inside the real setter; its target and destructor's
victim are different geoms. It is not available in production. Run
`src/modeling/script-setter-gc-browser-check.mjs` from `web/frontend` against a
separately served test WASM, with `WEBVSP_TEST_CHROMIUM` and optionally
`WEBVSP_TEST_PAGE` set, as described in that script. Use a fresh disposable
browser context/worker per run and discard it afterward, even on failure. The
probe reports actual destructor, victim and guard observations; it does not
establish that GC is normally triggered by a setter or that all writes are safe.

For a separate experiment, define `WEBVSP_DELETE_GEOM_PROXY_TEST` in addition to
both macros above, in a clean disposable test build's C++ flags. The script binding
for `DeleteGeom` alone then marks every live script guard and returns without calling
`vsp::DeleteGeom`; without a guard it forwards unchanged. This does **not** guard
GUI or C++ calls, other script APIs, or establish general reentry safety. The third
macro is forbidden in production even by itself. Never deploy this build. Run the
same browser check twice with `WEBVSP_DELETE_PROXY_CASE=control` and `setter`, each
in a fresh disposable browser context/worker: the first checks the unguarded positive
control and two nested guard markers, the second checks the setter GC block and reply.
Omit that variable only when testing the original two-macro observation build.

## How it works

| Piece | Where | What |
|---|---|---|
| Engine | `engine/engine.cpp` | OpenVSP runs `main()` on its own thread (`PROXY_TO_PTHREAD`), pumps the GUI and watches the model for changes. The page queues requests (`call`) and collects results, model events and GUI output (`take`). The request list is in its header comment. |
| Page side | `web/frontend/src/api/wasmEngine.ts` | Loads the module, sends requests, delivers events; GUI file choosers use the browser's file pickers (files live in the module's in-memory file system). |
| Threads | `web/frontend/public/coi-sw.js`, `main.tsx` | Threads need a cross-origin isolated page; static hosts can't send the headers, so a service worker adds them (one automatic reload). |
| FLTK | `fltk/` | A "headless" FLTK platform: windows exist and lay out but are never displayed; the event loop never blocks; text is measured with the browser's canvas. `patch_fltk.py` adds it to FLTK's sources at build time. |
| Plots | `src/gui_and_draw/WebMirror.cpp` | Plot widgets are captured as SVG (FLTK's SVG surface). |
| OpenGL | `engine/gl_stub.c` | The GUI never draws with OpenGL here: do-nothing GL generated from Emscripten's headers (`gen_gl_stub.py`, `gl_symbols.txt`). |
| VSPAERO | `src/util/WebProcess.h`, `web/frontend/public/program.worker.js` | `vspaero` and `vsploads` are WebAssembly programs too; OpenVSP starts them through the page, which runs each in a worker with copies of the working files. Single-threaded. |
| Scripting | `src/geom_core/ScriptCall.h` | AngelScript can't call native functions in WebAssembly; registrations go through generic wrappers. |
| Build | `build_wasm.ps1`, `toolchain.cmake` | Everything is built with `-pthread -fwasm-exceptions`. |

## Not available (yet)

- **STEP export**: STEPcode's build runs a code generator, which can't run when cross-compiling
  (`VSP_NO_STEP`).
- **VSPAERO's desktop viewer** (`vspviewer`, an OpenGL program). VSPAERO > Launch Viewer opens
  the page's own results viewer instead (`web/frontend/src/viewer/`).
- **Multithreaded VSPAERO** (no OpenMP) and **CalculiX** (structural analysis, not part of
  OpenVSP).
- Files are opened and saved through the browser. In Chrome and Edge, File > Save writes back to
  the file you opened or saved (after asking once for permission to edit it) and the pickers
  remember the folder; other browsers download the saved file.
