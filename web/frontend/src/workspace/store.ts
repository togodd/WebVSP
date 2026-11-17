// State for the workspace panel: the open flag, the file list and the filters.
//
// The list is read from the engine on demand and while the workspace panel is
// open. Polling is deliberately silent: solver runs and scripts can write files
// while the user is working, but a refresh must not erase a status message or
// interrupt a download/delete operation.
import { create } from 'zustand'
import { markWorkspaceModelDeleted } from './modelAssociation'
import {
  deleteWorkspaceFile,
  downloadWorkspaceFile,
  listWorkspace,
  type WorkspaceFile,
} from '../api/workspaceFiles'

export type SortKey = 'name' | 'size' | 'time'

interface WorkspaceState {
  open: boolean
  files: WorkspaceFile[]
  query: string
  sort: SortKey
  /** Sort direction; descending reverses the selected primary key. */
  descending: boolean
  busy: boolean
  message: string
  loaded: boolean
  toggle: () => void
  close: () => void
  refresh: () => Promise<void>
  setQuery: (query: string) => void
  setSort: (sort: SortKey) => void
  download: (file: WorkspaceFile) => Promise<void>
  remove: (file: WorkspaceFile) => Promise<void>
}

let seq = 0
let operation = 0
let listTail: Promise<unknown> = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0

// Serialize all listings, including manual and post-delete refreshes.
function listSerial(): Promise<WorkspaceFile[]> {
  const result = listTail.then(() => listWorkspace())
  listTail = result.catch(() => {})
  return result
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function stopPolling() {
  generation++
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
}

function onVisibility() {
  generation++
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  if (visible() && useWorkspaceFiles.getState().open) void poll(generation)
}

async function poll(run: number) {
  if (run !== generation || !useWorkspaceFiles.getState().open || !visible()) return
  if (!useWorkspaceFiles.getState().busy) {
    const token = seq
    try {
      const files = await listSerial()
      if (run === generation && token === seq && useWorkspaceFiles.getState().open && visible()) {
        useWorkspaceFiles.setState({ files, loaded: true })
      }
    } catch {
      // Automatic refresh is silent; manual refresh reports errors.
    }
  }
  if (run === generation && useWorkspaceFiles.getState().open && visible()) {
    timer = setTimeout(() => { timer = undefined; void poll(run) }, 1000)
  }
}

function startPolling() {
  stopPolling()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  if (visible()) void poll(generation)
}

export const useWorkspaceFiles = create<WorkspaceState>((set, get) => ({
  open: false,
  files: [],
  query: '',
  sort: 'name',
  descending: false,
  busy: false,
  message: '',
  loaded: false,

  toggle: () => {
    const open = !get().open
    set({ open })
    if (open) startPolling()
    else stopPolling()
  },

  close: () => { set({ open: false }); stopPolling() },

  refresh: async () => {
    const token = ++seq
    const owner = ++operation
    set({ busy: true, message: '' })
    try {
      const files = await listSerial()
      if (token !== seq || owner !== operation) return
      set({ files, loaded: true, busy: false, message: files.length ? '' : '/work 里还没有文件' })
    } catch (error) {
      if (token !== seq || owner !== operation) return
      set({ busy: false, message: error instanceof Error ? error.message : String(error) })
    }
  },

  setQuery: (query) => set({ query }),

  setSort: (sort) => {
    const { sort: current, descending } = get()
    if (sort === current) return set({ descending: !descending })
    set({ sort, descending: sort !== 'name' })
  },

  download: async (file) => {
    const owner = ++operation
    ++seq
    set({ busy: true, message: `下载 ${file.name}…` })
    try {
      await downloadWorkspaceFile(file)
      if (owner === operation) set({ busy: false, message: `已下载 ${file.name}` })
    } catch (error) {
      if (owner === operation) set({ busy: false, message: error instanceof Error ? error.message : String(error) })
    }
  },

  remove: async (file) => {
    const owner = ++operation
    ++seq // Invalidate listings started before the deletion.
    set({ busy: true })
    try {
      await deleteWorkspaceFile(file)
      markWorkspaceModelDeleted(file.path)
      ++seq // Also invalidate listings started while deletion was pending.
      const files = await listSerial()
      if (owner === operation) set({ files, loaded: true, busy: false, message: `已删除 ${file.name}` })
    } catch (error) {
      if (owner === operation) set({ busy: false, message: error instanceof Error ? error.message : String(error) })
    }
  },
}))

/** The fields the list filter needs; keep in step with the store. */
export interface FilterState { files: WorkspaceFile[]; query: string; sort: SortKey; descending: boolean }

/** Apply the panel's filter and sort order. */
export function visibleFiles(state: FilterState): WorkspaceFile[] {
  const needle = state.query.trim().toLowerCase()
  const filtered = needle ? state.files.filter((f) => f.rel.toLowerCase().includes(needle)) : state.files.slice()
  const compareName = (a: WorkspaceFile, b: WorkspaceFile) => {
    const byRelativePath = a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' })
    // Base sensitivity and numeric comparison can treat distinct paths as equal.
    return byRelativePath || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
  }
  const sign = state.descending ? -1 : 1
  filtered.sort((a, b) => {
    let primary = 0
    if (state.sort === 'size') primary = a.size - b.size
    else if (state.sort === 'time') primary = a.mtime - b.mtime
    else primary = compareName(a, b)

    // Reverse only the selected key. Equal size/mtime entries always use the
    // same ascending name order, making results deterministic in either direction.
    if (primary !== 0) return primary * sign
    return state.sort === 'name' ? 0 : compareName(a, b)
  })
  return filtered
}
