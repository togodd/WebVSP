import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Binding = { mtime: number; size: number; pending: boolean; writing: boolean }
type Files = { answer(vsp: unknown, dialog: unknown): Promise<void>; watch(vsp: unknown): void; clear(): void; state(path: string): Binding | undefined }
let files: Files
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  await import('./wasmEngine')
  files = (window as unknown as { __webvspEngine: { testFiles: Files } }).__webvspEngine.testFiles
})
beforeEach(() => files.clear())

const home = '/home/web_user/'
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function setup() {
  const data = new Map<string, { bytes: Uint8Array; time: number }>()
  const events: { result: number; path: string }[] = []
  const deliveries: string[] = []
  let failure = ''
  let target = 'a.vsp3'
  let imports = ['a.vsp3']
  const fs = {
    analyzePath: (p: string) => ({ exists: data.has(p) }),
    stat: (p: string) => {
      if (failure === p) throw Error('stat failed')
      const f = data.get(p)
      if (!f) throw { errno: 44 }
      return { mtime: new Date(f.time), size: f.bytes.length }
    },
    readFile: vi.fn((p: string) => data.get(p)!.bytes),
    writeFile: (p: string, bytes: Uint8Array) => { data.set(p, { bytes, time: 1 }) },
    mkdirTree: () => {},
  }
  const vsp = { FS: fs, mirrorEvent: (s: string) => events.push(JSON.parse(s)) }
  Object.assign(window, {
    showSaveFilePicker: async () => ({ name: target, queryPermission: async () => 'granted', createWritable: async () => ({ write: async () => { deliveries.push(target) }, close: async () => {} }) }),
    showOpenFilePicker: async () => imports.map(name => ({ getFile: async () => ({ name, arrayBuffer: async () => new Uint8Array([9]).buffer }) })),
  })
  const saveAs = () => files.answer(vsp, { seq: 1, mode: 1, filter: '*.vsp3' })
  const open = () => files.answer(vsp, { seq: 2, mode: 0, filter: '*.vsp3' })
  const put = (name: string, time: number, bytes: number[]) => data.set(home + name, { time, bytes: new Uint8Array(bytes) })
  return { data, events, deliveries, fs, vsp, saveAs, open, put, setFailure: (p: string) => { failure = p }, setTarget: (s: string) => { target = s }, setImports: (s: string[]) => { imports = s } }
}

describe('file dialog exact-path metadata guard', () => {
  it.each(['mtime', 'size', 'stat error', 'disappeared'] as const)('rejects %s before import without consuming watcher state', async (change) => {
    const s = setup(); s.put('a.vsp3', 1, [1]); await s.saveAs()
    const binding = files.state(home + 'a.vsp3')!
    const baseline = { ...binding }
    if (change === 'mtime') s.put('a.vsp3', 2, [1])
    if (change === 'size') s.put('a.vsp3', 1, [1, 2])
    if (change === 'stat error') s.setFailure(home + 'a.vsp3')
    if (change === 'disappeared') s.data.delete(home + 'a.vsp3')
    await s.open()
    expect(s.events.at(-1)?.result).toBe(0)
    expect(files.state(home + 'a.vsp3')).toBe(binding)
    expect(binding).toEqual(baseline)
    expect(s.fs.readFile).not.toHaveBeenCalled()
    if (change === 'mtime' || change === 'size') {
      files.watch(s.vsp); expect(binding.pending).toBe(true)
      files.watch(s.vsp); await flush(); expect(s.deliveries).toEqual(['a.vsp3'])
    }
  })
  it('checks secondary targets before committing any imported file', async () => {
    const s = setup(); s.put('b.vsp3', 1, [2]); s.setTarget('b.vsp3'); await s.saveAs()
    s.put('b.vsp3', 2, [2]); s.setImports(['a.vsp3', 'b.vsp3']); await s.open()
    expect(s.events.at(-1)?.result).toBe(0)
    expect(s.data.has(home + 'a.vsp3')).toBe(false)
    expect(s.data.get(home + 'b.vsp3')?.bytes[0]).toBe(2)
  })
  it('rejects Save As on changed or busy binding, while ordinary Save remains observable', async () => {
    const s = setup(); s.put('a.vsp3', 1, [1]); await s.saveAs()
    s.put('a.vsp3', 2, [2]); await s.saveAs()
    expect(s.events.at(-1)?.result).toBe(0)
    files.watch(s.vsp); await s.saveAs(); expect(s.events.at(-1)?.result).toBe(0)
    files.watch(s.vsp); await flush(); expect(s.deliveries).toEqual(['a.vsp3'])
    await s.saveAs(); expect(s.events.at(-1)?.result).toBe(1)
  })
  it('rejects an in-flight write without detaching it or reading the file', async () => {
    const s = setup(); s.put('a.vsp3', 1, [1]); await s.saveAs()
    const binding = files.state(home + 'a.vsp3')!
    binding.writing = true
    await s.open(); expect(s.events.at(-1)?.result).toBe(0)
    await s.saveAs(); expect(s.events.at(-1)?.result).toBe(0)
    expect(files.state(home + 'a.vsp3')).toBe(binding)
    expect(binding.writing).toBe(true)
    expect(s.fs.readFile).not.toHaveBeenCalled()
  })
  it('allows initially missing bindings only while still missing; accepts unchanged and unlinked paths', async () => {
    const s = setup(); await s.saveAs(); await s.saveAs(); expect(s.events.at(-1)?.result).toBe(1)
    s.put('a.vsp3', 1, [1]); await s.open(); expect(s.events.at(-1)?.result).toBe(0)
    s.data.delete(home + 'a.vsp3'); await s.open(); expect(s.events.at(-1)?.result).toBe(1)
    await s.open(); expect(s.events.at(-1)?.result).toBe(1)
    s.setImports(['other.vsp3']); await s.open(); expect(s.events.at(-1)?.result).toBe(1)
  })
})
