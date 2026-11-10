import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProgramSpawnDeps } from './wasmEngine'

let runProgram: typeof import('./wasmEngine').runProgram
let killProgram: typeof import('./wasmEngine').killProgram
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  ;({ runProgram, killProgram } = await import('./wasmEngine'))
})

function setup(cmd = 'vspaero') {
  const worker = { terminate: vi.fn(), postMessage: vi.fn(), onmessage: null, onerror: null } as unknown as Worker
  const vsp = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: vi.fn(), writeFile: vi.fn() },
    processOutput: vi.fn(), processExit: vi.fn(),
  } as unknown as Parameters<typeof runProgram>[0]
  const deps: ProgramSpawnDeps = {
    programs: new Map(), createWorker: () => worker, solverSpawned: vi.fn(), solverExited: vi.fn(), openViewer: vi.fn(),
  }
  runProgram(vsp, { t: 'spawn', id: 42, cmd }, deps)
  const message = (data: unknown) => worker.onmessage?.({ data } as MessageEvent)
  const error = () => worker.onerror?.({ message: 'broken' } as ErrorEvent)
  const late = () => { message({ type: 'exit', code: 0, files: [] }); error() }
  return { worker, vsp, deps, message, error, late }
}

describe('asynchronous worker completion', () => {
  it('writes all returned files before reporting a successful exit', () => {
    const s = setup()
    const order: unknown[] = []
    const first = new Uint8Array([1, 0, 255])
    const second = new Uint8Array([4, 5])
    vi.mocked(s.vsp.FS.mkdirTree).mockImplementation((path) => { order.push(['mkdir', path]) })
    vi.mocked(s.vsp.FS.writeFile).mockImplementation((path, data) => { order.push(['write', path, Array.from(data)]) })
    vi.mocked(s.vsp.processExit).mockImplementation((id, code) => { order.push(['exit', id, code]) })
    s.message({ type: 'exit', code: 0, files: [{ path: '/one/a', data: first }, { path: '/two/b', data: second }] })
    expect(order).toEqual([
      ['mkdir', '/one'], ['write', '/one/a', [1, 0, 255]],
      ['mkdir', '/two'], ['write', '/two/b', [4, 5]], ['exit', 42, 0],
    ])
    expect(s.deps.solverExited).toHaveBeenCalledExactlyOnceWith(0)
    expect(s.worker.terminate).toHaveBeenCalledTimes(1)
    expect(s.deps.programs.has(42)).toBe(false)
  })
  it('reports a partial writeback failure and ignores late events', () => {
    const s = setup()
    const written = new Map<string, number[]>()
    vi.mocked(s.vsp.FS.writeFile).mockImplementation((path, data) => {
      if (path === '/b') throw Error('write')
      written.set(path, Array.from(data))
    })
    s.message({ type: 'exit', code: 0, files: [
      { path: '/a', data: new Uint8Array([1, 2]) },
      { path: '/b', data: new Uint8Array([3]) },
      { path: '/c', data: new Uint8Array([4]) },
    ] })
    expect([...written]).toEqual([['/a', [1, 2]]])
    expect(s.vsp.FS.writeFile).toHaveBeenCalledTimes(2)
    expect(s.deps.solverExited).toHaveBeenCalledExactlyOnceWith(127)
    expect(s.vsp.processExit).toHaveBeenCalledExactlyOnceWith(42, 127)
    expect(s.worker.terminate).toHaveBeenCalledTimes(1)
    expect(s.deps.programs.has(42)).toBe(false)
    s.late()
    killProgram(s.vsp, 42, s.deps.programs)
    expect(s.vsp.FS.writeFile).toHaveBeenCalledTimes(2)
    expect(s.deps.solverExited).toHaveBeenCalledTimes(1)
    expect(s.worker.terminate).toHaveBeenCalledTimes(1)
    expect(s.vsp.processExit).toHaveBeenCalledTimes(1)
  })
  it('fails on mkdir or output exceptions', () => {
    for (const kind of ['mkdir', 'output'] as const) {
      const s = setup()
      if (kind === 'mkdir') {
        vi.mocked(s.vsp.FS.mkdirTree).mockImplementation(() => { throw Error() })
        s.message({ type: 'exit', code: 0, files: [{ path: '/a', data: new Uint8Array() }] })
      } else {
        vi.mocked(s.vsp.processOutput).mockImplementation(() => { throw Error() })
        s.message({ type: 'out', text: 'hello' })
      }
      expect(s.vsp.processExit).toHaveBeenCalledWith(42, 127)
      s.late()
      expect(s.vsp.processExit).toHaveBeenCalledTimes(1)
    }
  })
  it('attempts exit despite terminate, solver and error output failures', () => {
    const s = setup()
    vi.mocked(s.worker.terminate).mockImplementation(() => { throw Error() })
    s.deps.solverExited = () => { throw Error() }
    vi.mocked(s.vsp.processOutput).mockImplementation(() => { throw Error() })
    s.error()
    expect(s.vsp.processExit).toHaveBeenCalledWith(42, 127)
    s.late()
    expect(s.vsp.processExit).toHaveBeenCalledTimes(1)
  })
  it('changes successful exit to 127 when terminate throws', () => {
    const s = setup()
    vi.mocked(s.worker.terminate).mockImplementation(() => { throw Error() })
    s.message({ type: 'exit', code: 0, files: [] })
    expect(s.deps.solverExited).toHaveBeenCalledWith(127)
    expect(s.vsp.processExit).toHaveBeenCalledWith(42, 127)
  })
  it('preserves the code if solver notification has side effects then throws', () => {
    const s = setup()
    const observed: number[] = []
    s.deps.solverExited = (code) => { observed.push(code); throw Error('notification') }
    s.message({ type: 'exit', code: 0, files: [] })
    expect(observed).toEqual([0])
    expect(s.vsp.processExit).toHaveBeenCalledWith(42, 0)
  })
  it('shares once-only finish with kill', () => {
    const s = setup()
    killProgram(s.vsp, 42, s.deps.programs)
    s.late()
    expect(s.vsp.processExit).toHaveBeenCalledExactlyOnceWith(42, 143)
    expect(s.worker.terminate).toHaveBeenCalledTimes(1)
  })
  it('kills a non-vspaero worker without notifying the solver', () => {
    const s = setup('vsploads')
    expect(s.deps.solverSpawned).not.toHaveBeenCalled()
    killProgram(s.vsp, 42, s.deps.programs)
    s.late()
    killProgram(s.vsp, 42, s.deps.programs)
    expect(s.deps.solverSpawned).not.toHaveBeenCalled()
    expect(s.deps.solverExited).not.toHaveBeenCalled()
    expect(s.vsp.processOutput).toHaveBeenCalledExactlyOnceWith(42, 'Stopped.\n')
    expect(s.vsp.processExit).toHaveBeenCalledExactlyOnceWith(42, 143)
    expect(s.worker.terminate).toHaveBeenCalledTimes(1)
    expect(s.deps.programs.has(42)).toBe(false)
  })
  it('uses the failure code for solver and process when kill output throws', () => {
    const s = setup()
    vi.mocked(s.vsp.processOutput).mockImplementation(() => { throw Error('output') })
    killProgram(s.vsp, 42, s.deps.programs)
    expect(s.deps.solverExited).toHaveBeenCalledExactlyOnceWith(127)
    expect(s.vsp.processExit).toHaveBeenCalledExactlyOnceWith(42, 127)
  })
  it('ignores reentrant worker events from terminate', () => {
    const s = setup()
    vi.mocked(s.worker.terminate).mockImplementation(() => { s.late() })
    s.message({ type: 'exit', code: 0, files: [] })
    expect(s.deps.solverExited).toHaveBeenCalledExactlyOnceWith(0)
    expect(s.vsp.processExit).toHaveBeenCalledExactlyOnceWith(42, 0)
    expect(s.worker.terminate).toHaveBeenCalledTimes(1)
  })
  it.each(['exit', 'kill'] as const)('does not reenter after processExit throws on %s', (kind) => {
    const s = setup()
    vi.mocked(s.vsp.processExit).mockImplementation(() => { throw Error('exit') })
    const complete = () => kind === 'exit'
      ? s.message({ type: 'exit', code: 0, files: [] })
      : killProgram(s.vsp, 42, s.deps.programs)
    expect(complete).toThrow('exit')
    expect(s.deps.programs.has(42)).toBe(false)
    s.late()
    killProgram(s.vsp, 42, s.deps.programs)
    expect(s.deps.solverExited).toHaveBeenCalledExactlyOnceWith(kind === 'exit' ? 0 : 143)
    expect(s.worker.terminate).toHaveBeenCalledTimes(1)
    expect(s.vsp.processExit).toHaveBeenCalledExactlyOnceWith(42, kind === 'exit' ? 0 : 143)
  })
  it('does not retry a throwing processExit', () => {
    const s = setup()
    vi.mocked(s.vsp.processExit).mockImplementation(() => { throw Error('exit') })
    expect(() => s.error()).toThrow('exit')
    s.late()
    expect(s.vsp.processExit).toHaveBeenCalledTimes(1)
  })
})
