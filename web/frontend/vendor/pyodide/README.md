# Vendored Pyodide wheels

These are unmodified wheels from the Pyodide 314.0.8 release at `https://cdn.jsdelivr.net/pyodide/v314.0.8/full/`. They match the npm `pyodide@314.0.8` lock metadata and are distributed here so the fixed diagnostic loads them same-origin without runtime access to a CDN. `scripts/copy-pyodide.mjs` checks each wheel's SHA-256 and the Pyodide lock before staging; builds fail on mismatch.

| Wheel | SHA-256 |
| --- | --- |
| `numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf` |
| `six-1.17.0-py2.py3-none-any.whl` | `228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42` |
| `scipy-1.18.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `17ee329a957863516d1bb6a6aaa0c60576fac027e9cd3d43de27f58b5b599b50` |

The NumPy, six and SciPy wheels contain their license information and third-party notices in their `.dist-info` directories. SciPy's lock entry depends on NumPy, which is vendored separately; `copy-pyodide.mjs` checks that exact dependency closure rather than assuming zero dependencies. SciPy is ~14 MB, so the console installs it on demand (see the README) instead of on every session start. Reevaluate the ABI, dependency graph, integrity pins, and license notices when upgrading Pyodide.
