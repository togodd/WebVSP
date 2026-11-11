import { beforeAll, describe, expect, it, vi } from 'vitest'
import { useFileNotice } from './fileNotice'

let answer: (vsp: never, dialog: never) => Promise<void>
let testFiles: { clear: () => void; state: (path: string) => { pending: boolean } }
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  await import('./wasmEngine')
  testFiles = (window as unknown as { __webvspEngine: { testFiles: typeof testFiles } }).__webvspEngine.testFiles
  answer = (testFiles as unknown as { answer: typeof answer }).answer
})

describe('busy file dialog completion', () => {
  it('answers once before notifying even when a subscriber throws', async () => {
    testFiles.clear()
    const data = new Map<string, Uint8Array>()
    const mirrorEvent = vi.fn()
    const vsp = { mirrorEvent, FS: {
      mkdirTree() {}, writeFile: (p: string, d: Uint8Array) => data.set(p, d),
      analyzePath: (p: string) => ({ exists: data.has(p) }), stat: (p: string) => ({ mtime: new Date(0), size: data.get(p)!.length }),
    } }
    Object.assign(window, { showOpenFilePicker: async () => [{ getFile: async () => ({ name: 'a.vsp3', arrayBuffer: async () => new Uint8Array([1]).buffer }) }] })
    const dialog = { seq: 1, mode: 0, filter: '*.vsp3' }
    await answer(vsp as never, dialog as never)
    testFiles.state('/home/web_user/a.vsp3').pending = true
    const unsubscribe = useFileNotice.subscribe(() => { throw Error('broken listener') })
    await answer(vsp as never, { ...dialog, seq: 2 } as never)
    unsubscribe()
    expect(mirrorEvent).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mirrorEvent.mock.calls[1][0])).toMatchObject({ seq: 2, result: 0 })
    expect([...data.get('/home/web_user/a.vsp3')!]).toEqual([1])
  })
})
