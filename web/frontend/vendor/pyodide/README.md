# Vendored Pyodide wheels

These are unmodified wheels from the Pyodide 314.0.8 release at `https://cdn.jsdelivr.net/pyodide/v314.0.8/full/`. They match the npm `pyodide@314.0.8` lock metadata and are distributed here so the fixed diagnostic loads them same-origin without runtime access to a CDN. `scripts/copy-pyodide.mjs` checks each wheel's SHA-256 and the Pyodide lock before staging; builds fail on mismatch.

| Wheel | SHA-256 |
| --- | --- |
| `numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf` |
| `six-1.17.0-py2.py3-none-any.whl` | `228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42` |
| `scipy-1.18.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `17ee329a957863516d1bb6a6aaa0c60576fac027e9cd3d43de27f58b5b599b50` |
| `matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `722857932f8f62eac64f8439af15c94d427f9fb945f9590cd242805c983d2d54` |
| `contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `0ac15ebf9f820d2d1c3526388aa2818b631cb6c4aae1682efd6b4cc12c1f302c` |
| `cycler-0.12.1-py3-none-any.whl` | `8ee450085f15b47f78b034d60059af6a3649e98fa5dde073363437742cc0b4ea` |
| `fonttools-4.62.1-py3-none-any.whl` | `0d1516e073fd0a8d8e6d9af46417b6a26209a42518024a18f7085e72d2599605` |
| `kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `47781998156721147c128a3c74547d5703e0e3cc454d8203e629339368308a93` |
| `packaging-26.1-py3-none-any.whl` | `565acbbea54da30348b6d68b6a54373e6f777987db9f1db6966b4b3a5060d303` |
| `pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `e29838b7a756e4ee0f27a9cfa9a387ee0dfa2e9dd44be2dd595130b9f9d93ac3` |
| `pyparsing-3.3.2-py3-none-any.whl` | `f0dd8225b5f8e945980b400bd465b4b90cb0498a2eede0d9dbea98372f6110c5` |
| `python_dateutil-2.9.0.post0-py2.py3-none-any.whl` | `9b13365edf9c188f570baf9c540bbb3029ada2a2dacb9694b3659941693ee9e5` |
| `pytz-2026.1.post1-py2.py3-none-any.whl` | `b8249d6450146e0b61e6d710dc02ebb35a904796c4c2f97fe87d4ac5872db36a` |
| `pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | `45ff57772cc2f366a8582c7d3097cc4e6676342ecd5a3c08184a43462d5a02ae` |


The Matplotlib and pandas stacks bring their own dependencies (contourpy, cycler,
fonttools, kiwisolver, packaging, pillow, pyparsing, python-dateutil, pytz), all
vendored here and pinned in both `scripts/copy-pyodide.mjs` and this table. SciPy,
Matplotlib and pandas are installed on demand by the console; NumPy and six are
preinstalled every session.

The NumPy, six, SciPy, Matplotlib and pandas wheels contain their license information and third-party notices in their `.dist-info` directories. SciPy's lock entry depends on NumPy, which is vendored separately; `copy-pyodide.mjs` checks that exact dependency closure rather than assuming zero dependencies. SciPy (~14 MB), Matplotlib (~7 MB plus dependencies) and pandas (~4 MB) are installed on demand (see the README) instead of on every session start. Reevaluate the ABI, dependency graph, integrity pins, and license notices when upgrading Pyodide.
