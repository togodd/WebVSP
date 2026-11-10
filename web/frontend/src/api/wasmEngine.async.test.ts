import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProgramSpawnDeps } from './wasmEngine'

let runProgram: typeof import('./wasmEngine').runProgram
let killProgram: typeof import('./wasmEngine').killProgram
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  ;({ runProgram, killProgram } = await import('./wasmEngine'))
})

function setup() {
  const worker = { terminate: vi.fn(), postMessage: vi.fn(), onmessage: null, onerror: null } as unknown as Worker
  const vsp = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: vi.fn(), writeFile: vi.fn() },
    processOutput: vi.fn(), processExit: vi.fn(),
  } as unknown as Parameters<typeof runProgram>[0]
  const deps: ProgramSpawnDeps = {
    programs: new Map(), createWorker: () => worker, solverSpawned: vi.fn(), solverExited: vi.fn(), openViewer: vi.fn(),
  }
  runProgram(vsp, { t: 'spawn', id: 42, cmd: 'vspaero' }, deps)
  const message = (data: unknown) => worker.onmessage?.({ data } as MessageEvent)
  const error = () => worker.onerror?.({ message: 'broken' } as ErrorEvent)
  const late = () => { message({ type: 'exit', code: 0, files: [] }); error() }
  return { worker, vsp, deps, message, error, late }
}

describe('asynchronous worker completion', () => {
  it('writes all returned files before reporting a successful exit', () => {
    const s = setup()
    const order: string[] = []
    vi.mocked(s.vsp.FS.mkdirTree).mockImplementation(() => { order.push('mkdir') })
    vi.mocked(s.vsp.FS.writeFile).mockImplementation(() => { order.push('write') })
    vi.mocked(s.vsp.processExit).mockImplementation(() => { order.push('exit') })
    s.message({ type: 'exit', code: 0, files: [{ path: '/a', data: new Uint8Array([1]) }, { path: '/b', data: new Uint8Array([2]) }] })
    expect(order).toEqual(['mkdir', 'write', 'mkdir', 'write', 'exit'])
    expect(s.vsp.processExit).toHaveBeenCalledWith(42, 0)
  })
  it('reports a partial writeback failure and ignores late events', () => {
    const s = setup()
    vi.mocked(s.vsp.FS.writeFile).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw Error('write') })
    s.message({ type: 'exit', code: 0, files: [{ path: '/a', data: new Uint8Array() }, { path: '/b', data: new Uint8Array() }] })
    expect(s.vsp.FS.writeFile).toHaveBeenCalledTimes(2)
    expect(s.vsp.processExit).toHaveBeenCalledWith(42, 127)
    s.late()
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
  it('does not retry a throwing processExit', () => {
    const s = setup()
    vi.mocked(s.vsp.processExit).mockImplementation(() => { throw Error('exit') })
    expect(() => s.error()).toThrow('exit')
    s.late()
    expect(s.vsp.processExit).toHaveBeenCalledTimes(1)
  })
})
