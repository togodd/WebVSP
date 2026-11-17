// The workspace listing's pure parts: classification, filtering and the store's
// delete-then-refresh flow.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/wasmEngine', () => ({
  engineListFiles: vi.fn(),
  readEngineFile: vi.fn(),
  saveEngineFile: vi.fn(),
  engineDeleteFile: vi.fn(),
}))

import { classify, formatSize, formatTime, listWorkspace } from '../api/workspaceFiles'
import { engineDeleteFile, engineListFiles } from '../api/wasmEngine'
import { useWorkspaceFiles, visibleFiles, type FilterState } from './store'
import type { WorkspaceFile } from '../api/workspaceFiles'

const file = (rel: string, size = 10, mtime = 1000): WorkspaceFile => ({
  path: `/work/${rel}`,
  name: rel.split('/').pop()!,
  rel,
  size,
  mtime,
  kind: classify(rel).kind,
  ext: rel.includes('.') ? rel.split('.').pop()! : '',
})

describe('classify', () => {
  it('maps known extensions to a kind and glyph', () => {
    expect(classify('a.vsp3')).toMatchObject({ kind: 'model', glyph: '▣' })
    expect(classify('a.ADB').kind).toBe('result')
    expect(classify('a.csv').kind).toBe('table')
    expect(classify('a.png').kind).toBe('image')
    expect(classify('a.py').kind).toBe('script')
  })

  it('falls back to "other" for unknown or missing extensions', () => {
    expect(classify('noext').kind).toBe('other')
    expect(classify('weird.bin').kind).toBe('other')
  })
})

describe('formatSize', () => {
  it('switches units at the boundaries', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KiB')
    expect(formatSize(20 * 1024)).toBe('20 KiB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MiB')
  })
})

describe('formatTime', () => {
  it('shows a time for today and a date for older files', () => {
    const now = Date.now()
    expect(formatTime(now)).toMatch(/\d{1,2}[:.]\d{2}/)
    expect(formatTime(now - 5 * 24 * 3600 * 1000)).not.toMatch(/^\d{1,2}[:.]\d{2}/)
  })
})

describe('visibleFiles', () => {
  const state = (patch: Partial<FilterState>): FilterState => ({
    files: [file('b.csv', 30, 3000), file('a.vsp3', 10, 1000), file('dir/c.txt', 20, 2000)],
    query: '',
    sort: 'name',
    descending: false,
    ...patch,
  })

  it('sorts by relative path with numbers in order', () => {
    expect(visibleFiles(state({})).map((f) => f.rel)).toEqual(['a.vsp3', 'b.csv', 'dir/c.txt'])
  })

  it('sorts by size and time, newest largest first when descending', () => {
    expect(visibleFiles(state({ sort: 'size', descending: true })).map((f) => f.rel)).toEqual(['b.csv', 'dir/c.txt', 'a.vsp3'])
    expect(visibleFiles(state({ sort: 'time' })).map((f) => f.rel)).toEqual(['a.vsp3', 'dir/c.txt', 'b.csv'])
  })

  it('filters on any part of the relative path, case-insensitively', () => {
    expect(visibleFiles(state({ query: 'DIR/' })).map((f) => f.rel)).toEqual(['dir/c.txt'])
    expect(visibleFiles(state({ query: 'nomatch' }))).toEqual([])
  })
})

describe('listWorkspace', () => {
  it('turns engine entries into workspace files with a relative path', async () => {
    vi.mocked(engineListFiles).mockResolvedValueOnce([
      { path: '/work/x/b.vsp3', name: 'b.vsp3', size: 5, mtime: 1 },
      { path: '/work/a/csv.csv', name: 'csv.csv', size: 6, mtime: 2 },
    ])
    const files = await listWorkspace()
    expect(files.map((f) => f.rel)).toEqual(['a/csv.csv', 'x/b.vsp3'])
    expect(files.map((f) => f.kind)).toEqual(['table', 'model'])
  })
})

describe('workspace store', () => {
  beforeEach(() => {
    useWorkspaceFiles.getState().close()
    vi.clearAllMocks()
  })

  afterEach(() => {
    useWorkspaceFiles.getState().close()
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })

  it('opens with an immediate refresh and polls once per second', async () => {
    vi.useFakeTimers()
    let visibility: 'visible' | 'hidden' = 'visible'
    const listeners = new Set<() => void>()
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      get visibilityState() { return visibility },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    } })
    vi.mocked(engineListFiles).mockResolvedValue([])

    useWorkspaceFiles.getState().toggle()
    await vi.waitFor(() => expect(engineListFiles).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(engineListFiles).toHaveBeenCalledTimes(2))

    visibility = 'hidden'
    listeners.forEach((listener) => listener())
    await vi.advanceTimersByTimeAsync(2000)
    expect(engineListFiles).toHaveBeenCalledTimes(2)
  })

  it('does not let an automatic refresh clobber a delete operation', async () => {
    vi.useFakeTimers()
    vi.mocked(engineListFiles).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 100)))
    vi.mocked(engineDeleteFile).mockResolvedValue()
    const target = file('gone.txt')
    useWorkspaceFiles.setState({ files: [target], loaded: true })
    useWorkspaceFiles.getState().toggle()
    const deletion = useWorkspaceFiles.getState().remove(target)
    await vi.advanceTimersByTimeAsync(250)
    await deletion
    expect(useWorkspaceFiles.getState().message).toContain('已删除')
  })

  it('deletes then reloads the list', async () => {
    vi.mocked(engineListFiles).mockResolvedValue([
      { path: '/work/keep.txt', name: 'keep.txt', size: 1, mtime: 1 },
    ])
    vi.mocked(engineDeleteFile).mockResolvedValue()
    useWorkspaceFiles.setState({ files: [file('gone.txt')], loaded: true })

    await useWorkspaceFiles.getState().remove(file('gone.txt'))

    expect(engineDeleteFile).toHaveBeenCalledWith('/work/gone.txt')
    expect(useWorkspaceFiles.getState().files.map((f) => f.rel)).toEqual(['keep.txt'])
    expect(useWorkspaceFiles.getState().message).toContain('已删除')
  })

  it('reports a delete failure without dropping the list', async () => {
    vi.mocked(engineDeleteFile).mockRejectedValueOnce(new Error('File not found: /work/gone.txt'))
    useWorkspaceFiles.setState({ files: [file('gone.txt')], loaded: true, message: '' })

    await useWorkspaceFiles.getState().remove(file('gone.txt'))

    expect(useWorkspaceFiles.getState().files.map((f) => f.rel)).toEqual(['gone.txt'])
    expect(useWorkspaceFiles.getState().message).toContain('File not found')
    expect(useWorkspaceFiles.getState().busy).toBe(false)
  })
})
