import { useStore } from '../store'
import { onEngineEvent, restoreModel, snapshotModel, wasmRequest } from './wasmEngine'

/**
 * Autosave of the unsaved model in this browser (IndexedDB, one record). After each change the
 * model is copied out; a model with no geoms clears the copy. A reload of an empty session puts
 * the copy straight back: the page reopens with the model as it was, with no dialog.
 */

const DB = 'webvsp-autosave'
const STORE = 'model'
const KEY = 'current'
/** Quiet time after the last change before a copy is written. */
const DEBOUNCE_MS = 1000

interface Snapshot {
  bytes: Uint8Array<ArrayBuffer>
  /** The model's own name in the engine (its file name, or OpenVSP's default). */
  name: string
  savedAt: number
}

// ------------------------------------------------------------------ storage

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Run one request on the store and close the database after it. */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = run(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function readRecord(): Promise<Snapshot | undefined> {
  return withStore<Snapshot | undefined>('readonly', (s) => s.get(KEY))
}

async function writeRecord(record: Snapshot): Promise<void> {
  await withStore('readwrite', (s) => s.put(record, KEY))
}

async function deleteRecord(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(KEY))
}

// ------------------------------------------------------------------ saving

let enabled = false
let started = false
let timer: ReturnType<typeof setTimeout> | undefined
/** Saves run one at a time, in order. */
let queue: Promise<void> = Promise.resolve()

async function save() {
  if (!enabled) return
  const model = (await wasmRequest('GET', '/model')) as { geoms: unknown[] }
  if (!enabled) return
  if (!model.geoms.length) {
    await deleteRecord()
    return
  }
  const snap = await snapshotModel()
  if (!enabled) return
  await writeRecord({ bytes: snap.bytes, name: snap.name, savedAt: Date.now() })
}

function requestSave() {
  if (!enabled) return
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    queue = queue.then(save).catch((err) => console.warn('WebVSP: autosave failed', err))
  }, DEBOUNCE_MS)
}

// ------------------------------------------------------------------ startup

/** Begin autosave for this page. Safe to call more than once. */
export function startAutosave() {
  if (started) return
  started = true
  onEngineEvent((e) => {
    if (e.type === 'model_changed') requestSave()
  })
  void (async () => {
    // Until the restored model is in place, nothing may be written over the copy.
    try {
      const record = await readRecord()
      const model = (await wasmRequest('GET', '/model')) as { geoms: unknown[] }
      if (record && !model.geoms.length) {
        await restoreModel(record.bytes, record.name)
        await useStore.getState().loadTree()
        useStore.getState().refitAll()
      }
    } catch (err) {
      // A copy that can't be restored leaves an empty session; the page still works.
      console.warn('WebVSP: could not restore the autosaved model', err)
    } finally {
      enabled = true
    }
  })()
}
