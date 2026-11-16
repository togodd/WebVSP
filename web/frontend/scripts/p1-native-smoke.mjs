#!/usr/bin/env node
// Exercise the standalone Emscripten program, not the page engine.
// Usage: node web/frontend/scripts/p1-native-smoke.mjs [path/to/vsp_p1_analysis.js]
// The corresponding .wasm must be beside the JS, as in the normal build.
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultModule = resolve(dirname(fileURLToPath(import.meta.url)), '../public/wasm/vsp_p1_analysis.js')
const modulePath = resolve(process.argv[2] ?? defaultModule)
const PREFIX = 'WEBVSP_P1_RESULT='
const limits = { bytes: 8 * 1024 * 1024, results: 4096, fields: 100000, values: 500000 }
const links = {
  DegenGeom: new Set(['Degen_DegenGeoms', 'surf', 'sticks', 'hinges', 'point', 'disk', 'plates']),
  SurfacePatches: new Set(['components', 'surfaces', 'patches']),
}

function checkSnapshot(raw, model, analysis) {
  assert.ok(Buffer.byteLength(raw, 'utf8') <= limits.bytes, 'snapshot byte budget')
  const snapshot = JSON.parse(raw)
  assert.equal(snapshot.protocol, 'webvsp-p1-analysis')
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.model, model)
  assert.equal(snapshot.analysis, analysis)
  assert.ok(typeof snapshot.root === 'string' && snapshot.root.length > 0, 'nonempty root')
  assert.ok(Array.isArray(snapshot.results) && snapshot.results.length > 0 && snapshot.results.length <= limits.results, 'result budget')
  const ids = new Set()
  let fields = 0, values = 0, references = 0
  for (const result of snapshot.results) {
    assert.ok(typeof result.id === 'string' && result.id && !ids.has(result.id), 'unique nonempty result ID')
    ids.add(result.id)
    assert.ok(typeof result.name === 'string' && result.name, 'result name')
    assert.ok(Array.isArray(result.fields))
    fields += result.fields.length
    const indices = new Map()
    for (const field of result.fields) {
      assert.ok(typeof field.name === 'string' && field.name, 'field name')
      assert.ok(Number.isInteger(field.index) && field.index >= 0, 'field index')
      const seen = indices.get(field.name) ?? new Set()
      assert.ok(!seen.has(field.index), 'duplicate field index')
      seen.add(field.index); indices.set(field.name, seen)
      assert.ok(Array.isArray(field.value) && field.value.length <= limits.values, 'array budget')
      const number = x => typeof x === 'number' && Number.isFinite(x)
      const integer = x => Number.isInteger(x) && x >= -2147483648 && x <= 2147483647
      const vector = x => Array.isArray(x) && x.length === 3 && x.every(number)
      const matrix = (x, check) => Array.isArray(x) && x.length <= limits.values && x.every(check)
      const checks = { 1: integer, 2: number, 3: x => typeof x === 'string', 4: vector,
        5: x => matrix(x, integer), 6: x => matrix(x, number) }
      assert.ok(Object.hasOwn(checks, field.type), `unsupported type ${field.type}`)
      assert.ok(field.value.every(checks[field.type]), `invalid ${field.name} value`)
      // Writer counts numeric/string leaves, not arrays or field metadata.
      for (const item of field.value) values += Array.isArray(item) ? item.length : 1
    }
    for (const indexes of indices.values()) for (let i = 0; i < indexes.size; i++) assert.ok(indexes.has(i), 'non-contiguous field indexes')
  }
  assert.ok(ids.has(snapshot.root), 'root missing from results')
  assert.ok(fields <= limits.fields, 'field budget')
  assert.ok(values <= limits.values, 'value budget')
  for (const result of snapshot.results) for (const field of result.fields) {
    if (!links[analysis].has(field.name)) continue
    assert.equal(field.type, 3, `reference field ${field.name} must be string`)
    for (const id of field.value) { assert.ok(ids.has(id), `missing ${field.name} result ${id}`); references++ }
  }
  assert.ok(references > 0, 'expected linked results')
  return { bytes: Buffer.byteLength(raw, 'utf8'), results: ids.size, fields, values, references }
}

async function main() {
  assert.ok(process.argv.length <= 3, 'Usage: node p1-native-smoke.mjs [module.js]')
  const factory = (await import(pathToFileURL(modulePath).href)).default
  assert.equal(typeof factory, 'function', 'module must export an Emscripten factory')
  async function run(args) {
    const stdout = [], stderr = []
    const instance = await factory({ noInitialRun: true, print: s => stdout.push(String(s)), printErr: s => stderr.push(String(s)) })
    let before
    // FS is not exported by the standard build; only inspect it when available.
    const fs = instance.FS
    const listFiles = () => {
      const files = []
      function walk(path) {
        for (const name of fs.readdir(path)) {
          if (name === '.' || name === '..') continue
          const p = path === '/' ? `/${name}` : `${path}/${name}`
          const stat = fs.lstat(p)
          if (fs.isDir(stat.mode)) walk(p)
          else if (fs.isFile(stat.mode)) files.push(`${p}:${createHash('sha256').update(fs.readFile(p)).digest('hex')}`)
        }
      }
      // Standard virtual filesystems include dynamic devices/proc; inspect working directory only.
      walk(fs.cwd())
      return files.sort()
    }
    if (fs) {
      // Isolate the analysis working directory from Emscripten's /dev and /proc.
      fs.mkdirTree('/p1-fs-smoke')
      fs.chdir('/p1-fs-smoke')
      before = listFiles()
    }
    let status
    // Emscripten may prepend the program name to the supplied array in place.
    const savedExitCode = process.exitCode
    try { status = instance.callMain([...args]) } catch (error) {
      if (typeof error?.status !== 'number') throw error
      status = error.status
    } finally { process.exitCode = savedExitCode }
    if (fs) assert.deepEqual(listFiles(), before, 'analysis created or modified a working-directory file')
    return { status, stdout, stderr, fsChecked: !!fs }
  }
  let fsChecked = true
  for (const model of ['WING', 'PROP']) for (const analysis of ['DegenGeom', 'SurfacePatches']) {
    const result = await run([model, analysis]); fsChecked &&= result.fsChecked
    assert.equal(result.status, 0, `${model}/${analysis}: ${result.stderr.join('\n')}`)
    const lines = result.stdout.filter(s => s.startsWith(PREFIX))
    assert.equal(lines.length, 1, `${model}/${analysis}: expected exactly one result line`)
    const stats = checkSnapshot(lines[0].slice(PREFIX.length), model, analysis)
    console.log(`PASS ${model}/${analysis} ${JSON.stringify(stats)}`)
  }
  for (const args of [[], ['WING'], ['WING', 'DegenGeom', 'extra'], ['INVALID', 'DegenGeom'], ['wing', 'DegenGeom'], ['WING', 'INVALID'], ['WING', 'degengeom']]) {
    const result = await run(args); fsChecked &&= result.fsChecked
    assert.equal(result.status, 2, `invalid arguments ${JSON.stringify(args)}: expected status 2`)
    assert.ok(result.stderr.some(s => s.includes('Usage:')), 'expected usage diagnostic')
    assert.ok(!result.stdout.some(s => s.startsWith(PREFIX)), 'invalid request published a result')
    console.log(`PASS invalid ${JSON.stringify(args)}`)
  }
  console.log(fsChecked ? 'PASS no working-directory files created or modified' : 'SKIP filesystem output check: module does not export FS')
  console.log('Budget checks cover observed outputs only; fixed models cannot force budget exhaustion.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
