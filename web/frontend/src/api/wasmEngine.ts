/**
 * The engine: OpenVSP compiled to WebAssembly (web/wasm/engine/engine.cpp), running in this tab.
 *
 *   - requests (method + path, e.g. GET /geoms/{id}/mesh; see wasmRequest) are queued to
 *     OpenVSP's thread;
 *   - a fast loop collects their results, model-change events and the mirrored GUI's output,
 *     and hands the events to the page (wasmConnect);
 *   - GUI input and dialog answers go straight to the mirror.
 * File choosers in the GUI use the browser's file pickers; files live in the module's
 * in-memory file system (see answerFileDialog below).
 *
 * OpenVSP runs on its own thread, which needs a cross-origin isolated page (SharedArrayBuffer);
 * main.tsx arranges that before the app starts.
 */
import type { SocketMessage } from './client'
import type { MDialog } from '../mirror/types'
import { useViewer } from '../viewer/store'
import { offerResults } from './solverResults'
import { onSolverEnded, solverExited, solverSpawned } from './solverRun'
import { submitPending } from './pendingCall'
import { settleBridgeResult } from './settleBridgeResult'
import { emitListeners } from './emitListeners'
import { drainBatch } from './drainBatch'

interface VspModule {
  call(id: number, op: string, a: string, b: string, value: number): void
  callGuarded(id: number, op: string, a: string, b: string, value: number, expectedEpoch: string): void
  mirrorEvent(json: string): void
  take(): string
  takeBinary(id: number): Uint8Array | null
  requestFull(): void
  processOutput(id: number, text: string): void
  processExit(id: number, code: number): void
  FS: {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
    stat(path: string): { mtime: Date; size: number; mode: number }
    mkdirTree(path: string): void
    analyzePath(path: string): { exists: boolean }
    readdir(path: string): string[]
    isFile(mode: number): boolean
  }
}

export class WasmEngineError extends Error {
  status: number
  readonly outcome?: 'not_written' | 'different' | 'unknown'
  readonly actual?: number | null
  readonly code?: string
  constructor(status: number, message: string, outcome?: 'not_written' | 'different' | 'unknown', actual?: number | null, code?: string) {
    super(message)
    this.status = status
    this.outcome = outcome
    this.actual = actual
    this.code = code
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

// Identity of this engine-module lifetime, not a model/file identity or concurrency token.
let engineSessionId: string | undefined
export function getEngineSessionId(): string {
  if (!engineSessionId) {
    if (!globalThis.crypto?.randomUUID) throw new WasmEngineError(500, 'A secure browser context with crypto.randomUUID is required for modeling sessions')
    engineSessionId = globalThis.crypto.randomUUID()
  }
  return engineSessionId
}

let modulePromise: Promise<VspModule> | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const listeners = new Set<(e: SocketMessage) => void>()
let ready: (() => void) | null = null
const readyPromise = new Promise<void>((r) => (ready = r))

function emit(e: SocketMessage) {
  emitListeners(listeners, e)
}

function load(): Promise<VspModule> {
  modulePromise ??= (async () => {
    // Served as static files (web/frontend/public/wasm), not bundled: large and optional.
    const url = new URL(`${import.meta.env.BASE_URL}wasm/vsp.js`, window.location.href).href
    const { default: createVspModule } = await import(/* @vite-ignore */ url)
    const vsp = (await createVspModule()) as VspModule
    const tick = () => {
      try {
        drain(vsp)
      } catch (err) {
        console.error('WebVSP engine:', err)
      }
    }
    // Faster than the GUI's 30 Hz refresh; keeps going in background tabs (unlike rAF).
    setInterval(tick, 16)
    return vsp
  })()
  return modulePromise
}

function drain(vsp: VspModule) {
  const batch = JSON.parse(vsp.take()) as {
    out: Record<string, unknown>[]
    mirror: Record<string, unknown>[]
    proc: ProcRequest[]
  }
  drainBatch(batch, (r) => {
    if (r.t === 'spawn') runProgram(vsp, r)
    else if (r.t === 'kill') killProgram(vsp, r.id)
  }, (m) => {
    if (m.t === 'result') {
      settleBridgeResult(pending, m, (id) => vsp.takeBinary(id), (result) => {
        const outcome = result.outcome === 'not_written' || result.outcome === 'different' || result.outcome === 'unknown' ? result.outcome : undefined
        const actual = typeof result.actual === 'number' && Number.isFinite(result.actual) ? result.actual : result.actual === null ? null : undefined
        const code = typeof result.code === 'string' ? result.code : undefined
        return new WasmEngineError(code === 'STALE_MODEL' ? 409 : 400, String(result.error), outcome, actual, code)
      })
    } else if (m.type === 'engine_ready') {
      if (m.gui) {
        emit({ type: 'mirror_snapshot', enabled: true, windows: [], widgets: [], dialogs: [] })
        vsp.requestFull()
      }
      ready?.()
    } else {
      emit(m as unknown as SocketMessage)
    }
  }, (mirror) => {
    const files = mirror.filter((m) => m.t === 'dialog' && m.kind === 'file')
    // Answered here with the browser's pickers, not the UI's file browser.
    for (const m of files) m.native = true
    // The UI must know a prompt before it hears it was answered.
    emit({ type: 'mirror', msgs: mirror })
    for (const m of files) void answerFileDialog(vsp, m as unknown as MDialog)
  })
  watchLinked(vsp)
}

async function call(op: string, a = '', b = '', value = 0): Promise<unknown> {
  const vsp = await load()
  await readyPromise
  const id = nextId++
  return submitPending(pending, id, () => vsp.call(id, op, a, b, value))
}

/** Internal discovery snapshot: no epoch required, but serializer errors are fatal. */
export async function discoverModel<T = unknown>(): Promise<T> {
  return await call('modelDiscovery') as T
}

/** A model identity token is an opaque decimal string, never a JavaScript number. */
export interface EngineModelEpoch {
  modelEpoch: string
  modelEpochValid: boolean
}

/** Deliberately limited to operations that do not pump the GUI or replace the model. */
export const GUARDED_OPS = ['model', 'bbox', 'origin', 'move', 'addGeom', 'geomXSecs', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm', 'fuselageLength', 'geomSetParm', 'xsecSetParm'] as const
export type GuardedOp = (typeof GUARDED_OPS)[number]

/** Submit against the engine's model identity, checked atomically on its owning thread. */
export async function callGuarded<T = unknown>(op: GuardedOp, a: string, b: string, value: number, expectedEpoch: string): Promise<T> {
  if (!(GUARDED_OPS as readonly string[]).includes(op)) {
    throw new WasmEngineError(400, 'Operation is not permitted by the guarded bridge', 'not_written')
  }
  if (typeof expectedEpoch !== 'string' || expectedEpoch.length === 0) {
    throw new WasmEngineError(400, 'expectedEpoch is required', 'not_written')
  }
  return submitGuarded<T>(op, a, b, value, expectedEpoch)
}

// The dev-only hook bypasses bridge validation so browser tests exercise engine parsing itself.
async function submitGuarded<T = unknown>(op: string, a: string, b: string, value: number, expectedEpoch: string): Promise<T> {
  const vsp = await load()
  await readyPromise
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (result) => resolve(result as T), reject })
    try {
      vsp.callGuarded(id, op, a, b, value, expectedEpoch)
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

/** Same contract as the HTTP request(): JSON results as objects, meshes as ArrayBuffers. */
export async function wasmRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  const route = `${method} ${path.split('?')[0]}`
  let m: RegExpMatchArray | null

  if (route === 'GET /model') {
    const tree = (await call('model')) as { fileName: string }
    // A model never saved has OpenVSP's bare default name: no file name at all. A file the user
    // opened or saved is in HOME, so one actually called Unnamed.vsp3 still shows.
    return { ...tree, fileName: tree.fileName === 'Unnamed.vsp3' ? '' : displayName(tree.fileName) }
  }
  if ((m = route.match(/^GET \/geoms\/([^/]+)\/fuselage-length$/))) return call('fuselageLength', decodeURIComponent(m[1]))
  if ((m = route.match(/^GET \/geoms\/([^/]+)\/xsecs$/))) return call('geomXSecs', decodeURIComponent(m[1]))
  if ((m = route.match(/^GET \/(geoms|xsecs)\/([^/]+)\/parms(?:\/([^/]+))?$/))) {
    const owner = decodeURIComponent(m[2])
    const isXSec = m[1] === 'xsecs'
    return call(m[3] ? (isXSec ? 'xsecParm' : 'geomParm') : (isXSec ? 'xsecParmIDs' : 'geomParmIDs'), owner, m[3] ? decodeURIComponent(m[3]) : '')
  }
  if ((m = route.match(/^PUT \/(geoms|xsecs)\/([^/]+)\/parms\/([^/]+)$/))) {
    if (typeof b.value !== 'number' || !Number.isFinite(b.value)) throw new WasmEngineError(400, 'Parameter value must be finite', 'not_written')
    return call(m[1] === 'geoms' ? 'geomSetParm' : 'xsecSetParm', decodeURIComponent(m[2]), decodeURIComponent(m[3]), b.value)
  }
  if (route === 'GET /geom-types') return call('geomTypes')
  if (route === 'GET /bbox') return call('bbox')
  if (route === 'GET /bbox/all') return call('bbox', 'all')
  if ((m = route.match(/^GET \/geoms\/([^/]+)\/mesh$/))) return call('mesh', decodeURIComponent(m[1]))
  if (route === 'POST /geoms') return call('addGeom', String(b.type), b.parent ? String(b.parent) : '')
  if (route === 'POST /geoms/delete') return call('deleteGeoms', (b.ids as string[]).join(','))
  if ((m = route.match(/^PUT \/parms\/([^/]+)$/))) return call('setParm', decodeURIComponent(m[1]), '', Number(b.value))
  if (route === 'POST /file/new') return call('newModel')
  if (route === 'POST /pick') return call('pick', String(b.id ?? ''), b.toggle ? '1' : '')
  if ((m = route.match(/^GET \/geoms\/([^/]+)\/origin$/))) return call('origin', decodeURIComponent(m[1]))
  if (route === 'POST /geoms/move') return call('move', (b.ids as string[]).join(','), (b.delta as number[]).join(','))
  if (route === 'POST /geoms/duplicate') return call('duplicate', (b.ids as string[]).join(','))
  if (route === 'POST /geoms/draw-type') return call('drawType', (b.ids as string[]).join(','), '', Number(b.type))
  if (route === 'POST /geoms/rotate') return call('rotate', (b.ids as string[]).join(','), (b.axis as number[]).join(','), Number(b.angle))
  throw new WasmEngineError(501, `Not available in the in-browser engine: ${method} ${path}`)
}

// For the browser console and tests: __webvspEngine.request('POST', '/geoms', { type: 'WING' })
(window as unknown as Record<string, unknown>).__webvspEngine = {
  request: wasmRequest,
  ...(import.meta.env.DEV ? { testCall: call, testCallGuarded: submitGuarded } : {}),
}

/** Stand-in for the WebSocket: "connected" once OpenVSP has started, then its events. */
export function wasmConnect(onEvent: (e: SocketMessage) => void, onStatus: (connected: boolean) => void) {
  listeners.add(onEvent)
  let closed = false
  load()
    .then(() => readyPromise)
    .then(
      () => !closed && onStatus(true),
      (err) => {
        console.error('WebVSP: the in-browser engine failed to load', err)
        onStatus(false)
      },
    )
  return {
    close: () => {
      closed = true
      listeners.delete(onEvent)
    },
    send: (msg: unknown) => {
      const m = msg as { type?: string; event?: Record<string, unknown> }
      if (m.type !== 'mirror_event' || !m.event) return
      // The mirror reads flat JSON: numbers and strings only.
      const flat: Record<string, string | number> = {}
      for (const [k, v] of Object.entries(m.event)) flat[k] = typeof v === 'number' || typeof v === 'string' ? v : String(v)
      void load().then((vsp) => vsp.mirrorEvent(JSON.stringify(flat)))
    },
  }
}

// ------------------------------------------------------------------ files

/** Folder in the module's file system for files the user opens or saves. */
const HOME = '/home/web_user'

function displayName(path: string) {
  return path.startsWith(HOME + '/') ? path.slice(HOME.length + 1) : path.replace(/^\//, '')
}

/** Extensions in an FLTK filter like "*.vsp3", "*.{af,dat}" or "Images (*.{jpg,png})". */
function filterExts(filter?: string): string[] {
  const exts: string[] = []
  for (const m of (filter ?? '').matchAll(/\*\.(\{[^}]*\}|[\w]+)/g)) {
    exts.push(...m[1].replace(/[{}]/g, '').split(',').map((e) => e.trim()))
  }
  return exts.filter((e) => e && e !== '*')
}

/**
 * A file in the module's file system that stands for one on the user's disk: a model the user
 * opened, or saved through a save dialog. Whenever OpenVSP writes it (Save, Save As, or any
 * other write), the new contents go back to the user's file: through its handle (Chrome/Edge,
 * overwriting it in place) or as a download (other browsers).
 */
interface LinkedFile {
  path: string
  handle: FileSystemFileHandle | null
  name: string
  /** Modification time and size last seen; a change starts a write-back once they settle. */
  mtime: number
  size: number
  /** Written since the last write-back, waiting for the file to stop changing */
  pending: boolean
  /** Being written back */
  writing: boolean
}
const linked = new Map<string, LinkedFile>()

function link(vsp: VspModule, path: string, handle: FileSystemFileHandle | null, name: string) {
  const exists = vsp.FS.analyzePath(path).exists
  const st = exists ? vsp.FS.stat(path) : null
  linked.set(path, { path, handle, name, mtime: st ? st.mtime.getTime() : 0, size: st ? st.size : -1, pending: false, writing: false })
}

/**
 * A GUI file chooser: pick with the browser, then answer with a path in the module's file
 * system. Opened files are copied in first; files OpenVSP writes are copied back out
 * (watchLinked). Chrome/Edge's file pickers remember the last folder.
 */
async function answerFileDialog(vsp: VspModule, d: MDialog) {
  const answer = (path: string) => {
    vsp.mirrorEvent(JSON.stringify({ op: 'dialog', seq: d.seq, result: path ? 1 : 0, path }))
    emit({ type: 'dialog_done', seq: d.seq })
  }
  const exts = filterExts(d.filter)
  const types = exts.length
    ? [{ description: exts.map((e) => e.toUpperCase()).join(', ') + ' files', accept: { 'application/octet-stream': exts.map((e) => '.' + e) } }]
    : undefined
  try {
    vsp.FS.mkdirTree(HOME)
    if (!d.mode) {
      // Several files can be picked: all are copied in (e.g. a model with its VSPAERO results,
      // for Load Previous Results), and OpenVSP gets the one its filter asks for.
      const picked = await pickFiles(exts, types)
      if (!picked.length) return answer('')
      for (const f of picked) vsp.FS.writeFile(`${HOME}/${f.name}`, new Uint8Array(await f.arrayBuffer()))
      const main = picked.find((f) => exts.some((e) => f.file.name.toLowerCase().endsWith('.' + e.toLowerCase()))) ?? picked[0]
      const path = `${HOME}/${main.name}`
      // File > Save writes the opened file again: that goes back to the file on disk.
      link(vsp, path, main.handle, main.name)
      if (main.handle) void askToWrite(main.handle)
      return answer(path)
    }
    const suggested = (d.preset || '').split(/[\\/]/).pop() || (exts[0] ? `Unnamed.${exts[0]}` : 'Unnamed')
    const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }
    let handle: FileSystemFileHandle | null = null
    let name = suggested
    if (w.showSaveFilePicker) {
      try {
        handle = await w.showSaveFilePicker({ id: 'webvsp', suggestedName: suggested, types })
      } catch {
        return answer('') // cancelled
      }
      name = handle.name
    }
    const path = `${HOME}/${name}`
    link(vsp, path, handle, name)
    answer(path)
  } catch (err) {
    console.error('WebVSP: file dialog failed', err)
    answer('')
  }
}

interface Picked {
  file: File
  name: string
  handle: FileSystemFileHandle | null
  arrayBuffer: () => Promise<ArrayBuffer>
}

function pickFiles(exts: string[], types: unknown): Promise<Picked[]> {
  const picked = (file: File, handle: FileSystemFileHandle | null): Picked => ({
    file,
    name: file.name,
    handle,
    arrayBuffer: () => file.arrayBuffer(),
  })
  const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }
  if (w.showOpenFilePicker) {
    return w
      .showOpenFilePicker({ id: 'webvsp', types, excludeAcceptAllOption: false, multiple: true })
      .then((handles) => Promise.all(handles.map(async (h) => picked(await h.getFile(), h))))
      .catch(() => [])
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (exts.length) input.accept = exts.map((e) => '.' + e).join(',')
    input.onchange = () => resolve([...(input.files ?? [])].map((f) => picked(f, null)))
    input.oncancel = () => resolve([])
    input.click()
  })
}

type PermissionHandle = FileSystemFileHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
}

/** Ask now, while the user is choosing the file, to be allowed to save back to it later. */
async function askToWrite(handle: FileSystemFileHandle) {
  const h = handle as PermissionHandle
  try {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted') await h.requestPermission?.({ mode: 'readwrite' })
  } catch {
    /* asked again when saving */
  }
}

/** Copy out linked files OpenVSP has finished writing (changed, then unchanged for a moment). */
function watchLinked(vsp: VspModule) {
  for (const f of linked.values()) {
    if (f.writing || !vsp.FS.analyzePath(f.path).exists) continue
    const st = vsp.FS.stat(f.path)
    const mtime = st.mtime.getTime()
    const changed = mtime !== f.mtime || st.size !== f.size
    if (changed) {
      Object.assign(f, { mtime, size: st.size, pending: true })
      continue
    }
    if (!f.pending) continue
    f.pending = false
    // A copy in an ordinary buffer: the module's memory is shared (threads).
    const bytes = new Uint8Array(vsp.FS.readFile(f.path))
    f.writing = true
    void deliver(f, bytes).finally(() => (f.writing = false))
  }
}

async function deliver(f: LinkedFile, bytes: Uint8Array<ArrayBuffer>) {
  if (f.handle) {
    try {
      const h = f.handle as PermissionHandle
      if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted') await h.requestPermission?.({ mode: 'readwrite' })
      const out = await f.handle.createWritable()
      await out.write(bytes)
      await out.close()
      return
    } catch (err) {
      // Not allowed to write to it (the user declined): hand it over as a download instead.
      console.warn(`WebVSP: couldn't save to ${f.name}; downloading it instead`, err)
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([bytes]))
  a.download = f.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

// ------------------------------------------------------------------ programs

/**
 * OpenVSP "starting" one of VSPAERO's programs (src/util/WebProcess.h): each run is a worker
 * (public/program.worker.js) with a fresh instance of the program, compiled to WebAssembly.
 * It gets copies of the files in the working folders, its output is fed back as it runs, and
 * the files it wrote are copied back before OpenVSP is told it has exited.
 */
interface ProcRequest {
  t: 'spawn' | 'kill'
  id: number
  cmd?: string
  args?: string[]
  cwd?: string
}

const programs = new Map<number, Worker>()
// Kill and worker events share the same once-only completion for each worker.
const programFinishes = new WeakMap<Worker, (code: number, output?: string) => void>()
/** The model VSPAERO last ran on: its path in the module's file system, without extension. */
let solverBase = ''

// A run that finished: its result files go next to the model on disk (solverResults.ts), for a
// model opened or saved from disk; a model never saved has nowhere to put them.
onSolverEnded((code) => {
  if (code !== 0 || !solverBase || !modulePromise) return
  void modulePromise.then((vsp) => {
    const model = linked.get(`${solverBase}.vsp3`)
    if (!model) return
    const dir = dirname(solverBase)
    const base = solverBase.slice(dir.length + 1)
    const files = vsp.FS.readdir(dir)
      .filter((n) => (n.startsWith(base + '.') || n.startsWith(base + '_')) && n !== model.name)
      .filter((n) => vsp.FS.isFile(vsp.FS.stat(`${dir}/${n}`).mode))
      .map((name) => ({ name, data: new Uint8Array(vsp.FS.readFile(`${dir}/${name}`)) }))
    void offerResults({ modelPath: model.path, modelName: model.name, modelHandle: model.handle, files })
  })
})

function dirname(path: string) {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

// Inject the external spawn effects so failures in the actual spawn path can be tested.
export interface ProgramSpawnDeps {
  programs: Map<number, Worker>
  createWorker: () => Worker
  solverSpawned: () => void
  solverExited: (code: number) => void
  openViewer: (vsp: VspModule, id: number, args: string[], exit: (code: number) => void) => void
}

export function runProgram(vsp: VspModule, r: ProcRequest, deps: ProgramSpawnDeps = {
  programs,
  createWorker: () => new Worker(new URL(`${import.meta.env.BASE_URL}program.worker.js`, window.location.href), { type: 'module' }),
  solverSpawned,
  solverExited,
  openViewer,
}) {
  let worker: Worker | undefined
  let solverStarted = false
  let finished = false
  let cmd = ''
  const finish = (initialCode: number, output?: string) => {
    if (finished) return
    finished = true // Even if processExit throws, do not try it twice.
    let code = initialCode
    if (worker && deps.programs.get(r.id) === worker) deps.programs.delete(r.id)
    try { worker?.terminate() } catch { code = 127 }
    if (output) try { vsp.processOutput(r.id, output) } catch { code = 127 }
    if (cmd === 'vspaero') {
      if (!solverStarted) {
        try { deps.solverSpawned() } catch { code = 127 }
      }
      // The callback may have already recorded code before throwing; do not change it.
      try { deps.solverExited(code) } catch (error) {
        try { console.error('solverExited failed', error) } catch { /* best effort */ }
      }
    }
    // processExit can itself throw; delivery to the engine cannot be guaranteed.
    vsp.processExit(r.id, code)
  }
  const exit = (code: number) => finish(code)
  try {
    cmd = (r.cmd ?? '').split('/').pop()!.replace(/\.exe$/i, '')
    const args = r.args ?? []
    if (cmd === 'vspviewer') return deps.openViewer(vsp, r.id, args, exit)
    const cwd = r.cwd || '/'
    // The folders the program reads and writes: the user's files, the working folder, and the
    // folders of any paths among its arguments (VSPAERO gets the model's path).
    const dirs = [...new Set([HOME, cwd, ...args.filter((a) => a.startsWith('/')).map(dirname)])]
    const files: { path: string; data: Uint8Array }[] = []
    for (const dir of dirs) {
      if (!vsp.FS.analyzePath(dir).exists) continue
      for (const name of vsp.FS.readdir(dir)) {
        const path = (dir === '/' ? '' : dir) + '/' + name
        if (name === '.' || name === '..' || !vsp.FS.isFile(vsp.FS.stat(path).mode)) continue
        files.push({ path, data: new Uint8Array(vsp.FS.readFile(path)) }) // ordinary (not shared) copies
      }
    }

    worker = deps.createWorker()
    const spawnedWorker = worker
    deps.programs.set(r.id, spawnedWorker)
    programFinishes.set(spawnedWorker, finish)
    if (cmd === 'vspaero') {
      solverStarted = true
      deps.solverSpawned()
      // Its last argument is the model's path without extension (relative to its folder).
      const last = args[args.length - 1] ?? ''
      solverBase = last.startsWith('/') ? last : `${cwd === '/' ? '' : cwd}/${last}`
    }
    spawnedWorker.onmessage = ({ data }) => {
      if (finished || deps.programs.get(r.id) !== spawnedWorker) return
      let code: number | undefined
      try {
        if (data.type === 'out') vsp.processOutput(r.id, data.text)
        else if (data.type === 'exit') {
          // A failure can leave earlier files written; this is not an atomic transaction.
          for (const f of data.files as { path: string; data: Uint8Array }[]) {
            vsp.FS.mkdirTree(dirname(f.path))
            vsp.FS.writeFile(f.path, f.data)
          }
          code = data.code
        }
      } catch {
        code = 127
      }
      if (code !== undefined) finish(code)
    }
    spawnedWorker.onerror = (e) => {
      if (finished || deps.programs.get(r.id) !== spawnedWorker) return
      finish(127, `${cmd}: ${e.message || 'failed to start'}\n`)
    }
    spawnedWorker.postMessage({ cmd, args, cwd, dirs, files }, files.map((f) => f.data.buffer))
  } catch (error) {
    if (finished) throw error
    finish(127, `${cmd || 'program'}: failed to start\n`)
  }
}

export function killProgram(_vsp: VspModule, id: number, activePrograms = programs) {
  const worker = activePrograms.get(id)
  if (!worker) return
  programFinishes.get(worker)?.(143, 'Stopped.\n')
}

/**
 * VSPAERO's viewer: shown in the page (src/viewer) instead of a desktop program. OpenVSP sees
 * it running until it's closed. Its last argument is the model's base path (<base>.adb).
 */
function openViewer(vsp: VspModule, id: number, args: string[], exit: (code: number) => void) {
  const base = (args[args.length - 1] ?? '').replace(/\.adb$/, '')
  const read = (path: string) => (vsp.FS.analyzePath(path).exists ? new Uint8Array(vsp.FS.readFile(path)) : null)
  const adb = read(`${base}.adb`)
  const cases = read(`${base}.adb.cases`)
  const polar = read(`${base}.polar`)
  if (!adb) {
    vsp.processOutput(id, `vspviewer: ${base}.adb not found\n`)
    exit(1)
    return
  }
  const name = base.split('/').pop() || base
  const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : '')
  useViewer.getState().show(name, adb.buffer, text(cases), text(polar), () => exit(0))
}
