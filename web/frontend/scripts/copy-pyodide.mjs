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
const reviewed = {
  numpy: ['numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl', 'a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf'],
  six: ['six-1.17.0-py2.py3-none-any.whl', '228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42'],
}
const lock = JSON.parse(await readFile(new URL('pyodide-lock.json', source), 'utf8'))
for (const [packageName, [name, expected]] of Object.entries(reviewed)) {
  const entry = lock.packages[packageName]
  if (!entry || entry.file_name !== name || entry.sha256 !== expected || !Array.isArray(entry.depends) || entry.depends.length) throw new Error(`Pyodide lock drift for ${packageName}`)
  const wheel = new URL(`../vendor/pyodide/${name}`, import.meta.url)
  const bytes = await readFile(wheel)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Invalid Pyodide wheel: ${name}`)
  await copyFile(fileURLToPath(wheel), fileURLToPath(new URL(name, target)))
}
