// "Python 工作区": a folder the page mirrors into the engine file system at /work.
//
// Python's file APIs are synchronous, so files must already be in the engine's
// MEMFS before a script runs. The page copies the chosen folder in once; files
// written by Python are written back through the folder (or downloaded when no
// folder is mounted). External changes to the folder after mounting are not
// watched; use "同步" to write back and re-mount to pick up new files.
import { create } from 'zustand'
import {
  engineListFiles,
  engineStatFile,
  engineWriteFile,
  isEnginePathLinked,
  linkEngineFile,
  readEngineFile,
  saveEngineFile,
} from '../api/wasmEngine'

export const WORKSPACE_ROOT = '/work'
const MAX_FILES = 200
const MAX_BYTES = 64 * 1024 * 1024
const MAX_DEPTH = 8

type WorkspaceState = {
  name: string | null
  writable: boolean
  files: number
  busy: boolean
  message: string
}

export const useWorkspace = create<WorkspaceState>(() => ({ name: null, writable: false, files: 0, busy: false, message: '' }))

let folder: FileSystemDirectoryHandle | null = null

function set(patch: Partial<WorkspaceState>) { useWorkspace.setState(patch) }

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
}

async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as PermissionHandle
  try {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true
    return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

interface Walked { path: string; name: string; handle: FileSystemFileHandle }

/** Depth-first listing of a directory, bounded in count and depth. */
async function walkDirectory(root: FileSystemDirectoryHandle): Promise<Walked[]> {
  const out: Walked[] = []
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) return
    // File System Access: entries() yields [name, handle]; values() yields handles only.
    const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()
    for await (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const [name, handle] = entry
      if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, depth + 1)
      else out.push({ path: `${prefix}${name}`, name, handle: handle as FileSystemFileHandle })
    }
  }
  await walk(root, '', 0)
  return out
}

async function ensureSubdirectory(path: string): Promise<FileSystemDirectoryHandle> {
  if (!folder) throw new Error('No workspace folder')
  let dir = folder
  for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true })
  return dir
}

async function writeToFolder(path: string, bytes: Uint8Array): Promise<void> {
  if (!folder) throw new Error('No workspace folder')
  const cut = path.lastIndexOf('/')
  const dir = await ensureSubdirectory(cut > 0 ? path.slice(0, cut) : '')
  const handle = await dir.getFileHandle(path.slice(cut + 1), { create: true })
  const out = await handle.createWritable()
  await out.write(new Uint8Array(bytes))
  await out.close()
}

/** Mirror a directory handle into /work and link every file for write-back. */
export async function mountWorkspaceHandle(handle: FileSystemDirectoryHandle): Promise<number> {
  const writable = await ensureWritable(handle)
  folder = handle
  const walked = await walkDirectory(handle)
  let bytes = 0
  let written = 0
  for (const item of walked) {
    const file = await item.handle.getFile()
    if (bytes + file.size > MAX_BYTES) break
    const data = new Uint8Array(await file.arrayBuffer())
    bytes += data.length
    await engineWriteFile(`${WORKSPACE_ROOT}/${item.path}`, data)
    await linkEngineFile(`${WORKSPACE_ROOT}/${item.path}`, item.handle, item.name)
    written += 1
  }
  set({ name: handle.name, writable, files: written, busy: false, message: written < walked.length ? '超出大小/数量上限，部分文件未载入' : '' })
  return written
}

/** Mirror a chosen folder into /work and link every file for write-back. */
export async function chooseWorkspaceFolder(): Promise<void> {
  const w = window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }
  if (!w.showDirectoryPicker) {
    set({ message: '此浏览器不支持选择文件夹，请用“添加文件”' })
    return
  }
  set({ busy: true, message: '' })
  try {
    const handle = await w.showDirectoryPicker({ id: 'webvsp-python-workspace', mode: 'readwrite' })
    await mountWorkspaceHandle(handle)
  } catch (error) {
    folder = null
    set({ busy: false, message: error instanceof DOMException && error.name === 'AbortError' ? '已取消' : `选择文件夹失败：${message(error)}` })
  }
}

/** Add individual files when no folder can be chosen (or as a partial mount). */
export async function addWorkspaceFiles(): Promise<void> {
  set({ busy: true, message: '' })
  try {
    const picked = await pickAnyFiles()
    if (!picked.length) { set({ busy: false, message: '已取消' }); return }
    let bytes = 0
    let written = 0
    for (const item of picked) {
      if (bytes + item.bytes.length > MAX_BYTES) break
      bytes += item.bytes.length
      const path = `${WORKSPACE_ROOT}/${item.name}`
      await engineWriteFile(path, item.bytes)
      await linkEngineFile(path, item.handle, item.name)
      written += 1
    }
    set({ files: useWorkspace.getState().files + written, busy: false, message: '' })
  } catch (error) {
    set({ busy: false, message: `添加文件失败：${message(error)}` })
  }
}

interface Picked { name: string; bytes: Uint8Array; handle: FileSystemFileHandle | null }

async function pickAnyFiles(): Promise<Picked[]> {
  const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }
  if (w.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({ id: 'webvsp-python-workspace', multiple: true })
      return Promise.all(handles.map(async (handle) => {
        const file = await handle.getFile()
        return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle }
      }))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return []
      throw error
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      const picked = await Promise.all([...(input.files ?? [])].map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle: null })))
      resolve(picked)
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}

/**
 * Write files Python created back to the folder (or download them). Files the
 * engine changed itself are already handled by watchLinked; this sweep covers
 * files that were not linked when they appeared.
 */
export async function syncWorkspace(): Promise<void> {
  const files = await engineListFiles(WORKSPACE_ROOT)
  let written = 0
  let failed = 0
  for (const file of files) {
    if (isEnginePathLinked(file.path)) continue
    try {
      const bytes = await readEngineFile(file.path)
      if (folder && useWorkspace.getState().writable) {
        await writeToFolder(file.path.slice(WORKSPACE_ROOT.length + 1), bytes)
        // Link so later writes to this path use the same handle.
        const cut = file.path.lastIndexOf('/')
        const dirName = file.path.slice(WORKSPACE_ROOT.length + 1, cut > 0 ? cut : undefined)
        const dir = await ensureSubdirectory(cut > 0 ? dirName : '')
        const handle = await dir.getFileHandle(file.name)
        await linkEngineFile(file.path, handle, file.name)
      } else {
        await saveEngineFile(file.path, file.name)
      }
      written += 1
    } catch (error) {
      failed += 1
      set({ message: `同步失败：${message(error)}` })
    }
  }
  set({ files: files.length })
  if (written || failed) set({ message: `已同步 ${written} 个文件${failed ? `，${failed} 个失败` : ''}` })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Refresh the workspace after a run; only an explicit folder is auto-synced. */
export async function autoSyncWorkspace(): Promise<void> {
  if (!folder) return
  try { await syncWorkspace() } catch (error) { set({ message: `自动同步失败：${message(error)}` }) }
}

/** Test seam: mount bytes as the workspace without a browser picker. */
export async function mountTestWorkspace(files: { name: string; bytes: Uint8Array }[]): Promise<void> {
  folder = null
  let count = 0
  for (const file of files) {
    await engineWriteFile(`${WORKSPACE_ROOT}/${file.name}`, file.bytes)
    await linkEngineFile(`${WORKSPACE_ROOT}/${file.name}`, null, file.name)
    count += 1
  }
  set({ name: 'test', writable: false, files: count, message: '' })
}

/** Stat helper for tests: does a workspace file exist and what size is it? */
export async function workspaceFileStat(name: string): Promise<{ size: number; mtime: number } | null> {
  return engineStatFile(`${WORKSPACE_ROOT}/${name}`)
}
