import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ stat: vi.fn(), write: vi.fn(), link: vi.fn(), list: vi.fn(), read: vi.fn(), save: vi.fn(), linked: vi.fn() }))
vi.mock('./wasmEngine', () => ({
  engineStatFile: engine.stat, engineWriteFile: engine.write, linkEngineFile: engine.link,
  engineListFiles: engine.list, readEngineFile: engine.read, saveEngineFile: engine.save, isEnginePathLinked: engine.linked,
}))
import { addWorkspaceFiles, mountTestWorkspace, mountWorkspaceHandle, syncWorkspace, useWorkspace } from './pythonWorkspace'

function file(name: string, size = 1): FileSystemFileHandle {
  return { kind: 'file', name, getFile: async () => ({ size, arrayBuffer: async () => new Uint8Array([1]).buffer }) } as unknown as FileSystemFileHandle
}
function dir(name: string, children: FileSystemHandle[]): FileSystemDirectoryHandle {
  return { kind: 'directory', name, entries: async function* () { for (const child of children) yield [child.name, child] } } as unknown as FileSystemDirectoryHandle
}
beforeEach(() => { vi.clearAllMocks(); useWorkspace.setState({ name: null, writable: false, files: 0, busy: false, message: '' }) })

describe('single-folder workspace', () => {
  it('mounts and links files, then synchronizes new files', async () => {
    await mountWorkspaceHandle(dir('folder', [file('a')]))
    expect(engine.write).toHaveBeenCalledWith('/work/a', new Uint8Array([1]))
    expect(engine.link).toHaveBeenCalledTimes(1)
    expect(useWorkspace.getState().message).toBe('')
    engine.list.mockResolvedValue([{ path: '/work/new', name: 'new' }])
    engine.read.mockResolvedValue(new Uint8Array([2]))
    await syncWorkspace()
    expect(engine.save).toHaveBeenCalledWith('/work/new', 'new')
  })
  it('reports count truncation only when an additional file exists', async () => {
    const files = Array.from({ length: 200 }, (_, i) => file(`${i}`))
    await mountWorkspaceHandle(dir('folder', files))
    expect(useWorkspace.getState().message).toBe('')
    await mountWorkspaceHandle(dir('folder', [...files, file('extra')]))
    expect(useWorkspace.getState().message).toContain('数量')
    expect(useWorkspace.getState().files).toBe(200)
  })
  it('reports depth truncation only for nonempty omitted directories', async () => {
    const nested = (leaf: FileSystemDirectoryHandle) => {
      let current = leaf
      for (let i = 0; i < 9; i++) current = dir(`${i}`, [current])
      return current
    }
    await mountWorkspaceHandle(nested(dir('leaf', [])))
    expect(useWorkspace.getState().message).toBe('')
    await mountWorkspaceHandle(nested(dir('leaf', [file('hidden')])))
    expect(useWorkspace.getState().message).toContain('深度')
  })
  it('reports size truncation and restores the test mount', async () => {
    await mountWorkspaceHandle(dir('folder', [file('large', 64 * 1024 * 1024 + 1)]))
    expect(useWorkspace.getState().message).toContain('大小')
    await mountTestWorkspace([{ name: 'test.py', bytes: new Uint8Array([3]) }])
    expect(engine.write).toHaveBeenCalledWith('/work/test.py', new Uint8Array([3]))
  })
  it('reports size truncation when adding files', async () => {
    const handles = [file('large', 1)]
    handles[0] = { ...handles[0], getFile: async () => ({ name: 'large', arrayBuffer: async () => new ArrayBuffer(64 * 1024 * 1024 + 1) }) } as unknown as FileSystemFileHandle
    vi.stubGlobal('window', { showOpenFilePicker: async () => handles })
    await addWorkspaceFiles()
    expect(useWorkspace.getState().message).toContain('大小')
    vi.unstubAllGlobals()
  })
})
