// Copy the pinned npm package's runtime files for same-origin, offline loading.
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = new URL('../node_modules/pyodide/', import.meta.url)
const target = new URL('../public/pyodide/', import.meta.url)
await mkdir(target, { recursive: true })
for (const name of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  await copyFile(fileURLToPath(new URL(name, source)), fileURLToPath(new URL(name, target)))
}
