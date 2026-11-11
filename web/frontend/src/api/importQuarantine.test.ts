import { beforeAll, describe, expect, it, vi } from 'vitest'
import { useFileNotice } from './fileNotice'

type Binding = { path: string }
type Files = { answer(vsp: unknown, dialog: unknown): Promise<void>; state(path: string): Binding | undefined; watch(vsp: unknown): void; clear(): void }
let files: Files
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  await import('./wasmEngine')
  files = (window as unknown as { __webvspEngine: { testFiles: Files } }).__webvspEngine.testFiles
})
const home = '/home/web_user/'

describe('failed import exact-path quarantine', () => {
  it('isolates every target, rejects open and save-as, and leaves unrelated paths usable', async () => {
    files.clear()
    const data = new Map<string, Uint8Array>()
    const events: { result: number; path: string }[] = []
    let imports = ['quarantine-a.vsp3', 'quarantine-b.dat']
    let target = 'quarantine-a.vsp3'
    let fail = true
    const fs = {
      mkdirTree() {},
      writeFile(path: string, bytes: Uint8Array) { data.set(path, bytes); if (fail) { fail = false; throw Error('after write') } },
      analyzePath: (path: string) => ({ exists: data.has(path) }),
      stat: (path: string) => ({ mtime: new Date(1), size: data.get(path)!.length }),
      readFile: (path: string) => data.get(path)!,
    }
    const vsp = { FS: fs, mirrorEvent: (json: string) => events.push(JSON.parse(json)) }
    Object.assign(window, {
      showOpenFilePicker: async () => imports.map(name => ({ getFile: async () => ({ name, arrayBuffer: async () => new Uint8Array([9]).buffer }) })),
      showSaveFilePicker: async () => ({ name: target }),
    })
    const open = () => files.answer(vsp, { seq: 1, mode: 0, filter: '*.vsp3' })
    const save = () => files.answer(vsp, { seq: 2, mode: 1, filter: '*.vsp3' })
    await open()
    expect(events).toHaveLength(1); expect(events[0].result).toBe(0)
    expect(data.has(home + imports[0])).toBe(true)
    expect(files.state(home + imports[0])).toBeUndefined()
    files.clear() // The dev helper cannot clear page-lifetime quarantine.
    imports = ['quarantine-b.dat']; await open()
    expect(events.at(-1)?.result).toBe(0)
    expect(useFileNotice.getState().notice).toMatchObject({ kind: 'quarantine', operation: 'open', name: 'quarantine-b.dat' })
    await save(); expect(events.at(-1)?.result).toBe(0)
    expect(useFileNotice.getState().notice).toMatchObject({ kind: 'quarantine', operation: 'save', name: target })
    target = 'quarantine-other.vsp3'; await save(); expect(events.at(-1)?.result).toBe(1)
    imports = ['quarantine-another.vsp3']; await open(); expect(events.at(-1)?.result).toBe(1)
    expect(data.has(home + 'quarantine-b.dat')).toBe(false)
  })

  it('does not deliver a reentrant replacement binding after the outer answer throws', async () => {
    files.clear()
    const path = home + 'quarantine-reentrant.vsp3'
    const data = new Map<string, { bytes: Uint8Array; time: number }>()
    const readFile = vi.fn((p: string) => data.get(p)!.bytes)
    const fs = {
      mkdirTree() {}, writeFile: (p: string, bytes: Uint8Array) => data.set(p, { bytes, time: 1 }),
      analyzePath: (p: string) => ({ exists: data.has(p) }),
      stat: (p: string) => ({ mtime: new Date(data.get(p)!.time), size: data.get(p)!.bytes.length }), readFile,
    }
    const events: { seq: number; result: number }[] = []
    let nested: Promise<void> | undefined
    const vsp = { FS: fs, mirrorEvent: (json: string) => {
      const event = JSON.parse(json) as { seq: number; result: number }
      events.push(event)
      if (event.seq === 4) {
        nested = files.answer(vsp, { seq: 5, mode: 1, filter: '*.vsp3', preset: 'quarantine-reentrant.vsp3' })
        throw Error('outer delivery uncertain')
      }
    } }
    Object.assign(window, { showSaveFilePicker: undefined, showOpenFilePicker: async () => [{ getFile: async () => ({ name: 'quarantine-reentrant.vsp3', arrayBuffer: async () => new Uint8Array([1]).buffer }) }] })
    await files.answer(vsp, { seq: 4, mode: 0, filter: '*.vsp3' })
    await nested
    expect(events).toEqual([{ op: 'dialog', seq: 4, result: 1, path }, { op: 'dialog', seq: 5, result: 0, path: '' }])
    expect(files.state(path)).toBeUndefined()
    data.set(path, { bytes: new Uint8Array([2]), time: 2 })
    files.watch(vsp); files.watch(vsp)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('blocks synchronous save reentry and watcher while preflighting a save', async () => {
    files.clear()
    const name = 'save-lock-reentry.vsp3', path = home + name
    const events: { seq: number; result: number }[] = []
    const readFile = vi.fn(() => new Uint8Array([1]))
    let nested: Promise<void> | undefined
    let reenter = false
    const fs = {
      mkdirTree() {}, analyzePath: () => ({ exists: true }), readFile,
      stat: () => {
        if (reenter) {
          reenter = false
          nested = files.answer(vsp, { seq: 12, mode: 1, preset: name })
          files.watch(vsp)
        }
        return { mtime: new Date(1), size: 1 }
      },
    }
    const vsp = { FS: fs, mirrorEvent: (json: string) => events.push(JSON.parse(json)) }
    Object.assign(window, { showSaveFilePicker: undefined })
    await files.answer(vsp, { seq: 10, mode: 1, preset: name })
    reenter = true
    await files.answer(vsp, { seq: 11, mode: 1, preset: name })
    await nested
    expect(events.map(e => [e.seq, e.result])).toEqual([[10, 1], [12, 0], [11, 1]])
    expect(readFile).not.toHaveBeenCalled()
    expect(files.state(path)).toBeDefined()
  })

  it('rejects an over-capacity import without filesystem changes and allows a later small import', async () => {
    files.clear()
    let names = Array.from({ length: 4097 }, (_, i) => `capacity-${i}.vsp3`)
    const data = new Map<string, Uint8Array>()
    const mkdirTree = vi.fn()
    const writeFile = vi.fn((path: string, bytes: Uint8Array) => data.set(path, bytes))
    const fs = {
      mkdirTree, writeFile,
      analyzePath: (path: string) => ({ exists: data.has(path) }),
      stat: (path: string) => ({ mtime: new Date(1), size: data.get(path)!.length }),
    }
    const mirrorEvent = vi.fn()
    Object.assign(window, { showOpenFilePicker: async () => names.map(name => ({
      getFile: async () => ({ name, arrayBuffer: async () => new ArrayBuffer(0) }),
    })) })
    const vsp = { FS: fs, mirrorEvent }
    await files.answer(vsp, { seq: 20, mode: 0, filter: '*.vsp3' })
    expect(mirrorEvent).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mirrorEvent.mock.calls[0][0])).toEqual({ op: 'dialog', seq: 20, result: 0, path: '' })
    expect(useFileNotice.getState().notice).toMatchObject({ kind: 'capacity', operation: 'open' })
    expect(mkdirTree).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    expect(data.size).toBe(0)
    expect(files.state(home + names[0])).toBeUndefined()
    names = ['capacity-later.vsp3']
    await files.answer(vsp, { seq: 21, mode: 0, filter: '*.vsp3' })
    expect(mirrorEvent).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mirrorEvent.mock.calls[1][0])).toEqual({ op: 'dialog', seq: 21, result: 1, path: home + names[0] })
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(files.state(home + names[0])).toBeDefined()
  })

  it('removes the new binding if answer delivery throws and never answers twice', async () => {
    files.clear()
    const data = new Map<string, Uint8Array>()
    const fs = { mkdirTree() {}, writeFile: (p: string, b: Uint8Array) => data.set(p, b), analyzePath: (p: string) => ({ exists: data.has(p) }), stat: (p: string) => ({ mtime: new Date(1), size: data.get(p)!.length }) }
    const mirrorEvent = vi.fn(() => { throw Error('delivery uncertain') })
    Object.assign(window, { showOpenFilePicker: async () => [{ getFile: async () => ({ name: 'quarantine-delivery.vsp3', arrayBuffer: async () => new Uint8Array([1]).buffer }) }] })
    await files.answer({ FS: fs, mirrorEvent }, { seq: 3, mode: 0, filter: '*.vsp3' })
    expect(mirrorEvent).toHaveBeenCalledTimes(1)
    expect(files.state(home + 'quarantine-delivery.vsp3')).toBeUndefined()
  })
})
