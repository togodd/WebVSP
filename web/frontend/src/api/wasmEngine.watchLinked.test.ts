import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Files = {
  answer: (vsp: unknown, dialog: unknown) => Promise<void>
  watch: (vsp: unknown) => void
  clear: () => void
  state: (path: string) => { pending: boolean; writing: boolean } | undefined
}
let files: Files
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  await import('./wasmEngine')
  files = (window as unknown as { __webvspEngine: { testFiles: Files } }).__webvspEngine.testFiles
})
beforeEach(() => {
  files.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

async function setup() {
  const content = new Map([['/home/web_user/a.vsp3', 1], ['/home/web_user/b.vsp3', 1]])
  const failure = { operation: '', path: '' }
  const check = (operation: string, path: string) => {
    if (failure.operation === operation && failure.path === path) throw Error(operation)
  }
  const writes: string[] = []
  const fs = {
    analyzePath: (path: string) => { check('analyze', path); return { exists: content.has(path) } },
    stat: (path: string) => { check('stat', path); return { mtime: new Date(content.get(path)!), size: 1 } },
    readFile: (path: string) => { check('read', path); return new Uint8Array([content.get(path)!]) },
    mkdirTree: () => {},
  }
  const vsp = { FS: fs, mirrorEvent: () => {} }
  let name = ''
  ;(window as unknown as { showSaveFilePicker: () => Promise<unknown> }).showSaveFilePicker = async () => {
    const pickedName = name
    return {
      name: pickedName, queryPermission: async () => 'granted',
      createWritable: async () => ({ write: async () => { writes.push(pickedName) }, close: async () => {} }),
    }
  }
  for (name of ['a.vsp3', 'b.vsp3']) await files.answer(vsp, { mode: 1, seq: 1 })
  return { content, failure, writes, vsp }
}

const a = '/home/web_user/a.vsp3'
const b = '/home/web_user/b.vsp3'
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('linked file watcher failure isolation', () => {
  it.each(['analyze', 'stat', 'read'])('isolates %s failures and recovers pending writes', async (operation) => {
    const s = await setup()
    s.content.set(a, 2); s.content.set(b, 2)
    files.watch(s.vsp) // observe both changes
    expect(files.state(a)?.pending).toBe(true)
    s.failure.operation = operation; s.failure.path = a
    expect(() => files.watch(s.vsp)).not.toThrow()
    expect(files.state(a)).toMatchObject({ pending: true, writing: false })
    expect(files.state(b)).toMatchObject({ pending: false, writing: true })
    await flush()
    expect(s.writes).toEqual(['b.vsp3'])
    s.failure.operation = ''
    files.watch(s.vsp)
    expect(files.state(a)).toMatchObject({ pending: false, writing: true })
    await flush()
    expect(s.writes).toEqual(['b.vsp3', 'a.vsp3'])
    expect(files.state(a)).toMatchObject({ pending: false, writing: false })
  })

  it('continues the scan if error logging itself throws', async () => {
    const s = await setup()
    s.content.set(a, 2); s.content.set(b, 2)
    files.watch(s.vsp)
    s.failure.operation = 'read'; s.failure.path = a
    vi.mocked(console.error).mockImplementation(() => { throw Error('logger') })
    expect(() => files.watch(s.vsp)).not.toThrow()
    await flush()
    expect(s.writes).toEqual(['b.vsp3'])
    expect(files.state(a)?.pending).toBe(true)
  })

  it('catches rejected delivery, clears writing, and does not promise retry', async () => {
    const s = await setup()
    vi.stubGlobal('document', { createElement: () => { throw Error('download failed') } })
    // Rebind to a handle whose write and fallback both fail.
    ;(window as unknown as { showSaveFilePicker: () => Promise<unknown> }).showSaveFilePicker = async () => ({
      name: 'a.vsp3', queryPermission: async () => 'granted', createWritable: async () => { throw Error('denied') },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await files.answer(s.vsp, { mode: 1, seq: 2 })
    s.content.set(a, 2)
    files.watch(s.vsp); files.watch(s.vsp)
    await flush()
    expect(files.state(a)).toMatchObject({ pending: false, writing: false })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('snapshot may be lost'), expect.any(Error))
    files.watch(s.vsp)
    expect(files.state(a)).toMatchObject({ pending: false, writing: false })
    // A throwing logger must not create another rejected promise either.
    vi.mocked(console.error).mockImplementation(() => { throw Error('logger') })
    s.content.set(a, 3)
    files.watch(s.vsp); files.watch(s.vsp)
    await flush()
    expect(files.state(a)).toMatchObject({ pending: false, writing: false })
    vi.unstubAllGlobals()
  })
})
