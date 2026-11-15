# Vendored Pyodide wheels

These are unmodified wheels from the Pyodide 314.0.8 release at `https://cdn.jsdelivr.net/pyodide/v314.0.8/full/`. They match the npm `pyodide@314.0.8` lock metadata and are distributed here so the fixed diagnostic loads them same-origin without runtime access to a CDN. `scripts/copy-pyodide.mjs` checks each wheel's SHA-256 and the Pyodide lock before staging; builds fail on mismatch.

| Wheel | SHA-256 |
| --- | --- |
| `numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf` |
| `six-1.17.0-py2.py3-none-any.whl` | `228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42` |

The NumPy wheel contains its license information and third-party notices, and the six wheel contains its license, in their `.dist-info` directories. Reevaluate the ABI, dependency graph, integrity pins, and license notices when upgrading Pyodide.
