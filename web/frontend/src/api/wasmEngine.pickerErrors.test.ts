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
