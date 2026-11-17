// State for the workspace panel: the open flag, the file list and the filters.
//
// The list is read from the engine on demand (open, refresh, after a delete);
// there is no watcher. Solver runs and scripts write files while the page is
// busy elsewhere, so the panel offers "刷新" rather than polling.
import { create } from 'zustand'
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
  /** Newest first for size/time; name is always ascending. */
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
    if (open && !get().loaded) void get().refresh()
  },

  close: () => set({ open: false }),

  refresh: async () => {
    const token = ++seq
    set({ busy: true, message: '' })
    try {
      const files = await listWorkspace()
      if (token !== seq) return
      set({ files, loaded: true, busy: false, message: files.length ? '' : '/work 里还没有文件' })
    } catch (error) {
      if (token !== seq) return
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
    set({ busy: true, message: `下载 ${file.name}…` })
    try {
      await downloadWorkspaceFile(file)
      set({ busy: false, message: `已下载 ${file.name}` })
    } catch (error) {
      set({ busy: false, message: error instanceof Error ? error.message : String(error) })
    }
  },

  remove: async (file) => {
    set({ busy: true })
    try {
      await deleteWorkspaceFile(file)
      // Refresh first: it clears the status line, so the confirmation goes after.
      await get().refresh()
      set({ message: `已删除 ${file.name}` })
    } catch (error) {
      set({ busy: false, message: error instanceof Error ? error.message : String(error) })
    }
  },
}))

/** The fields the list filter needs; keep in step with the store. */
export interface FilterState { files: WorkspaceFile[]; query: string; sort: SortKey; descending: boolean }

/** Apply the panel's filter and sort order. */
export function visibleFiles(state: FilterState): WorkspaceFile[] {
  const needle = state.query.trim().toLowerCase()
  const filtered = needle ? state.files.filter((f) => f.rel.toLowerCase().includes(needle)) : state.files.slice()
  const sign = state.descending && state.sort !== 'name' ? -1 : 1
  filtered.sort((a, b) => {
    if (state.sort === 'size') return (a.size - b.size) * sign
    if (state.sort === 'time') return (a.mtime - b.mtime) * sign
    return a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' })
  })
  return filtered
}
