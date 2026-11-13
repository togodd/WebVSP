import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileNotice } from './fileNotice'
import { usePartialImportNotice } from './partialImportNotice'

type Files = { answer(vsp: unknown, dialog: unknown): Promise<void>; clear(): void; state(path: string): unknown }
let files: Files
const path = '/home/web_user/a.vsp3'
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  await import('./wasmEngine')
  files = (window as unknown as { __webvspEngine: { testFiles: Files } }).__webvspEngine.testFiles
})
beforeEach(() => {
  files.clear()
  useFileNotice.setState({ notice: null })
  usePartialImportNotice.setState({ notices: [] })
  vi.restoreAllMocks()
})

async function setup() {
  const fs = {
    analyzePath: vi.fn(() => ({ exists: false })), stat: vi.fn(),
    mkdirTree: vi.fn(), writeFile: vi.fn(),
  }
  const mirrorEvent = vi.fn()
  const vsp = { FS: fs, mirrorEvent }
  Object.assign(window, { showSaveFilePicker: async () => ({ name: 'a.vsp3' }) })
  await files.answer(vsp, { seq: 1, mode: 1, filter: '*.vsp3' })
  const binding = files.state(path)
  const snapshot = { ...(binding as object) }
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return { fs, mirrorEvent, vsp, binding, snapshot }
}

const abort = () => new DOMException('cancelled', 'AbortError')
const errors = [
  ['synchronous', (e: unknown) => () => { throw e }],
  ['asynchronous', (e: unknown) => () => Promise.reject(e)],
] as const

describe('file dialog filter preparation', () => {
  it.each(['open', 'save'] as const)('%s rejects a numeric JSON filter before any picker or FS side effects', async (mode) => {
    const s = await setup()
    const openPicker = vi.fn()
    const savePicker = vi.fn()
    Object.assign(window, { showOpenFilePicker: openPicker, showSaveFilePicker: savePicker })
    await files.answer(s.vsp, { seq: 42, mode: mode === 'save' ? 1 : 0, filter: 987654321 })
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(JSON.parse(s.mirrorEvent.mock.calls[0][0])).toEqual({ op: 'dialog', seq: 42, result: 0, path: '' })
    expect(openPicker).not.toHaveBeenCalled()
    expect(savePicker).not.toHaveBeenCalled()
    expect(s.fs.analyzePath).not.toHaveBeenCalled()
    expect(s.fs.mkdirTree).not.toHaveBeenCalled()
    expect(s.fs.writeFile).not.toHaveBeenCalled()
    expect(files.state(path)).toBe(s.binding)
    expect(s.binding).toEqual(s.snapshot)
    expect(useFileNotice.getState().notice).toEqual(expect.objectContaining({ kind: 'error', operation: mode }))
    expect(JSON.stringify(useFileNotice.getState().notice)).not.toContain('987654321')
    expect(console.error).toHaveBeenCalledWith('WebVSP: file dialog failed', expect.any(TypeError))
    expect(usePartialImportNotice.getState().notices).toEqual([])
  })

  it.each([null, '*.vsp3'] as const)('accepts filter %s and passes the expected picker types', async (filter) => {
    const s = await setup()
    const picker = vi.fn(async () => { throw abort() })
    Object.assign(window, { showSaveFilePicker: picker })
    await files.answer(s.vsp, { seq: 43, mode: 1, filter })
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ types: filter === null ? undefined : [
      { description: 'VSP3 files', accept: { 'application/octet-stream': ['.vsp3'] } },
    ] }))
    expect(JSON.parse(s.mirrorEvent.mock.calls[0][0])).toEqual({ op: 'dialog', seq: 43, result: 0, path: '' })
    expect(useFileNotice.getState().notice).toBeNull()
  })

  it.each(['before', 'after'] as const)('attempts cancellation only once when mirrorEvent throws %s possible delivery', async (timing) => {
    const s = await setup()
    const delivered: string[] = []
    const error = new Error('mirror failure')
    s.mirrorEvent.mockImplementation((message: string) => {
      if (timing === 'after') delivered.push(message)
      throw error
    })
    const picker = vi.fn()
    Object.assign(window, { showOpenFilePicker: picker })
    await expect(files.answer(s.vsp, { seq: 44, mode: 0, filter: 123 })).rejects.toBe(error)
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(JSON.parse(s.mirrorEvent.mock.calls[0][0])).toEqual({ op: 'dialog', seq: 44, result: 0, path: '' })
    expect(delivered).toHaveLength(timing === 'after' ? 1 : 0)
    expect(picker).not.toHaveBeenCalled()
    expect(useFileNotice.getState().notice).toEqual(expect.objectContaining({ kind: 'error', operation: 'open' }))
    expect(console.error).toHaveBeenCalledWith('WebVSP: file dialog failed', expect.any(TypeError))
    // A throwing mirrorEvent cannot tell us whether the engine received the attempt.
  })

  it.each(['before', 'after'] as const)('does not retry a successful save answer when mirrorEvent throws %s possible delivery', async (timing) => {
    const s = await setup()
    const delivered: string[] = []
    const error = new Error('mirror failure')
    s.mirrorEvent.mockImplementation((message: string) => {
      if (timing === 'after') delivered.push(message)
      throw error
    })
    Object.assign(window, { showSaveFilePicker: async () => ({ name: 'other.vsp3' }) })
    await files.answer(s.vsp, { seq: 45, mode: 1, filter: '*.vsp3' })
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(JSON.parse(s.mirrorEvent.mock.calls[0][0])).toEqual({ op: 'dialog', seq: 45, result: 1, path: '/home/web_user/other.vsp3' })
    expect(delivered).toHaveLength(timing === 'after' ? 1 : 0)
    expect(files.state('/home/web_user/other.vsp3')).toBeDefined()
    expect(console.error).toHaveBeenCalledWith('WebVSP: file dialog failed', error)
  })
})

describe('native picker errors', () => {
  for (const mode of ['open', 'save'] as const) {
    for (const [timing, reject] of errors) {
      for (const cancelled of [false, true]) {
        it(`${mode}: ${timing} ${cancelled ? 'AbortError cancels' : 'failure reports error'}`, async () => {
          const s = await setup()
          const error = cancelled ? abort() : new Error('picker failed')
          Object.assign(window, { [mode === 'open' ? 'showOpenFilePicker' : 'showSaveFilePicker']: reject(error) })
          await files.answer(s.vsp, { seq: 2, mode: mode === 'save' ? 1 : 0, filter: '*.vsp3' })
          expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
          expect(JSON.parse(s.mirrorEvent.mock.calls[0][0])).toMatchObject({ seq: 2, result: 0, path: '' })
          expect(useFileNotice.getState().notice).toEqual(cancelled ? null : expect.objectContaining({ kind: 'error', operation: mode }))
          expect(usePartialImportNotice.getState().notices).toEqual([])
          expect(s.fs.mkdirTree).not.toHaveBeenCalled()
          expect(s.fs.writeFile).not.toHaveBeenCalled()
          expect(files.state(path)).toBe(s.binding)
          expect(s.binding).toEqual(s.snapshot)
        })
      }
    }
  }
  it.each(errors)('getFile %s failure, including AbortError, is not cancellation', async (_timing, reject) => {
    const s = await setup()
    Object.assign(window, { showOpenFilePicker: async () => [{ getFile: reject(abort()) }] })
    await files.answer(s.vsp, { seq: 2, mode: 0, filter: '*.vsp3' })
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(JSON.parse(s.mirrorEvent.mock.calls[0][0])).toMatchObject({ seq: 2, result: 0 })
    expect(useFileNotice.getState().notice).toEqual(expect.objectContaining({ kind: 'error', operation: 'open' }))
    expect(usePartialImportNotice.getState().notices).toEqual([])
    expect(s.fs.mkdirTree).not.toHaveBeenCalled()
    expect(s.fs.writeFile).not.toHaveBeenCalled()
    expect(files.state(path)).toBe(s.binding)
    expect(s.binding).toEqual(s.snapshot)
  })
  it('does not mistake a plain object named AbortError for cancellation', async () => {
    const s = await setup()
    Object.assign(window, { showOpenFilePicker: () => { throw { name: 'AbortError' } } })
    await files.answer(s.vsp, { seq: 2, mode: 0 })
    expect(useFileNotice.getState().notice).toEqual(expect.objectContaining({ kind: 'error', operation: 'open' }))
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
  })
  it('keeps input fallback cancellation working', async () => {
    const s = await setup()
    const input = { type: '', multiple: false, accept: '', oncancel: () => {}, click() { this.oncancel() } }
    vi.stubGlobal('document', { createElement: () => input })
    Object.assign(window, { showOpenFilePicker: undefined })
    await files.answer(s.vsp, { seq: 2, mode: 0, filter: '*.vsp3' })
    expect(input.accept).toBe('.vsp3')
    expect(s.mirrorEvent).toHaveBeenCalledTimes(1)
    expect(useFileNotice.getState().notice).toBeNull()
    expect(files.state(path)).toBe(s.binding)
  })
})
