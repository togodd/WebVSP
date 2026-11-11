import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissPartialImport, usePartialImportNotice } from './partialImportNotice'
import { notifyFileError } from './fileNotice'

type Files = { answer(vsp: unknown, dialog: unknown): Promise<void>; clear(): void }
let files: Files
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  await import('./wasmEngine')
  files = (window as unknown as { __webvspEngine: { testFiles: Files } }).__webvspEngine.testFiles
})
beforeEach(() => { files.clear(); usePartialImportNotice.setState({ notices: [] }) })

let nameSequence = 0
function setup(failure: 'mkdir' | 'write' | 'link' | 'stage') {
  const name = `partial-${++nameSequence}.vsp3`
  const data = new Map<string, Uint8Array>()
  let mkdirSideEffect = false
  const fs = {
    mkdirTree: () => { mkdirSideEffect = true; if (failure === 'mkdir') throw Error('mkdir after effect') },
    writeFile: (path: string, bytes: Uint8Array) => { data.set(path, bytes); if (failure === 'write') throw Error('write after effect') },
    analyzePath: () => { if (failure === 'link') throw Error('link error'); return { exists: true } },
    stat: () => ({ mtime: new Date(0), size: 1 }),
  }
  const mirrorEvent = vi.fn()
  Object.assign(window, { showOpenFilePicker: async () => [{ getFile: async () => ({ name, arrayBuffer: async () => { if (failure === 'stage') throw Error('read error'); return new Uint8Array([1]).buffer } }) }] })
  return { fs, data, mirrorEvent, get mkdirSideEffect() { return mkdirSideEffect }, run: () => files.answer({ FS: fs, mirrorEvent }, { seq: 7, mode: 0, filter: '*.vsp3' }) }
}

describe('partial import warning', () => {
  it.each(['mkdir', 'write', 'link'] as const)('warns after %s throws, and answers exactly once', async failure => {
    const s = setup(failure)
    await s.run()
    expect(s.mkdirSideEffect).toBe(true)
    if (failure !== 'mkdir') expect(s.data.size).toBe(1)
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(JSON.parse(s.mirrorEvent.mock.calls[0][0])).toMatchObject({ seq: 7, result: 0 })
    expect(usePartialImportNotice.getState().notices).toHaveLength(1)
  })
  it('warns if the answer throws after import side effects without retrying delivery', async () => {
    const s = setup('link')
    s.fs.analyzePath = () => ({ exists: true })
    s.mirrorEvent.mockImplementation(() => { throw Error('delivery outcome unknown') })
    await s.run()
    expect(s.data.size).toBe(1)
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(usePartialImportNotice.getState().notices).toHaveLength(1)
  })
  it('does not issue a severe warning for staging failure', async () => {
    const s = setup('stage'); await s.run()
    expect(s.mkdirSideEffect).toBe(false)
    expect(usePartialImportNotice.getState().notices).toHaveLength(0)
  })
  it('keeps a queue independent of ordinary timed notices and allows dismissal', async () => {
    vi.useFakeTimers()
    try {
      await setup('mkdir').run(); await setup('write').run()
      const ids = usePartialImportNotice.getState().notices
      notifyFileError({ kind: 'error', operation: 'open' })
      vi.advanceTimersByTime(11000)
      expect(usePartialImportNotice.getState().notices).toEqual(ids)
      dismissPartialImport(ids[0]); expect(usePartialImportNotice.getState().notices).toEqual([ids[1]])
    } finally { vi.useRealTimers() }
  })
  it('answers once even if a severe notice subscriber throws', async () => {
    const s = setup('write')
    const unsubscribe = usePartialImportNotice.subscribe(() => { throw Error('observer failed') })
    try { await s.run() } finally { unsubscribe() }
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(JSON.parse(s.mirrorEvent.mock.calls[0][0]).result).toBe(0)
  })
})
