// Copy the pinned npm package's runtime files for same-origin, offline loading.
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const source = new URL('../node_modules/pyodide/', import.meta.url)
const target = new URL('../public/pyodide/', import.meta.url)
await mkdir(target, { recursive: true })
for (const name of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  await copyFile(fileURLToPath(new URL(name, source)), fileURLToPath(new URL(name, target)))
}
// Vendor exact ABI-matched wheels; reject version drift, dependency drift and tampering.
// `depends` must equal the reviewed closure exactly: numpy and six are standalone;
// scipy may depend only on numpy (which is already installed).
const reviewed = {
  numpy: { name: 'numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl', sha256: 'a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf', depends: [] },
  six: { name: 'six-1.17.0-py2.py3-none-any.whl', sha256: '228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42', depends: [] },
  scipy: { name: 'scipy-1.18.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl', sha256: '17ee329a957863516d1bb6a6aaa0c60576fac027e9cd3d43de27f58b5b599b50', depends: ['numpy'] },
  // Plotting and tabular results: the OpenVSP plotting helpers and several
  // examples import these. Installed on demand, not at session start.
  matplotlib: { name: 'matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl', sha256: '722857932f8f62eac64f8439af15c94d427f9fb945f9590cd242805c983d2d54', depends: ['contourpy', 'cycler', 'fonttools', 'kiwisolver', 'numpy', 'packaging', 'pillow', 'pyparsing', 'python-dateutil', 'pytz'] },
  contourpy: { name: 'contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl', sha256: '0ac15ebf9f820d2d1c3526388aa2818b631cb6c4aae1682efd6b4cc12c1f302c', depends: ['numpy'] },
  cycler: { name: 'cycler-0.12.1-py3-none-any.whl', sha256: '8ee450085f15b47f78b034d60059af6a3649e98fa5dde073363437742cc0b4ea', depends: ['six'] },
  fonttools: { name: 'fonttools-4.62.1-py3-none-any.whl', sha256: '0d1516e073fd0a8d8e6d9af46417b6a26209a42518024a18f7085e72d2599605', depends: [] },
  kiwisolver: { name: 'kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl', sha256: '47781998156721147c128a3c74547d5703e0e3cc454d8203e629339368308a93', depends: [] },
  packaging: { name: 'packaging-26.1-py3-none-any.whl', sha256: '565acbbea54da30348b6d68b6a54373e6f777987db9f1db6966b4b3a5060d303', depends: [] },
  pillow: { name: 'pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl', sha256: 'e29838b7a756e4ee0f27a9cfa9a387ee0dfa2e9dd44be2dd595130b9f9d93ac3', depends: [] },
  pyparsing: { name: 'pyparsing-3.3.2-py3-none-any.whl', sha256: 'f0dd8225b5f8e945980b400bd465b4b90cb0498a2eede0d9dbea98372f6110c5', depends: [] },
  'python-dateutil': { name: 'python_dateutil-2.9.0.post0-py2.py3-none-any.whl', sha256: '9b13365edf9c188f570baf9c540bbb3029ada2a2dacb9694b3659941693ee9e5', depends: ['six'] },
  pytz: { name: 'pytz-2026.1.post1-py2.py3-none-any.whl', sha256: 'b8249d6450146e0b61e6d710dc02ebb35a904796c4c2f97fe87d4ac5872db36a', depends: [] },
  pandas: { name: 'pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl', sha256: '45ff57772cc2f366a8582c7d3097cc4e6676342ecd5a3c08184a43462d5a02ae', depends: ['numpy', 'python-dateutil', 'pytz'] },
}
const lock = JSON.parse(await readFile(new URL('pyodide-lock.json', source), 'utf8'))
for (const [packageName, { name, sha256: expected, depends }] of Object.entries(reviewed)) {
  const entry = lock.packages[packageName]
  if (!entry || entry.file_name !== name || entry.sha256 !== expected) throw new Error(`Pyodide lock drift for ${packageName}`)
  if (!Array.isArray(entry.depends) || entry.depends.length !== depends.length || depends.some(dep => !entry.depends.includes(dep))) {
    throw new Error(`Pyodide dependency drift for ${packageName}: ${JSON.stringify(entry.depends)}`)
  }
  const wheel = new URL(`../vendor/pyodide/${name}`, import.meta.url)
  const bytes = await readFile(wheel)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Invalid Pyodide wheel: ${name}`)
  await copyFile(fileURLToPath(wheel), fileURLToPath(new URL(name, target)))
}
