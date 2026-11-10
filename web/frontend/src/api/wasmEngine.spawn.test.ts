import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProgramSpawnDeps } from './wasmEngine'

let runProgram: typeof import('./wasmEngine').runProgram
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  ;({ runProgram } = await import('./wasmEngine'))
})

function setup() {
  const events: string[] = []
  const worker = {
    terminate: vi.fn(() => { events.push('terminate') }),
    postMessage: vi.fn(), onmessage: null, onerror: null,
  } as unknown as Worker
  const vsp = {
    FS: { analyzePath: () => ({ exists: false }) },
    processOutput: vi.fn(() => { events.push('output') }),
    processExit: vi.fn((_id: number, code: number) => { events.push(`exit:${code}`) }),
  } as unknown as Parameters<typeof runProgram>[0]
  const deps: ProgramSpawnDeps = {
    programs: new Map(), createWorker: () => worker,
    solverSpawned: () => { events.push('spawn') },
    solverExited: () => { events.push('solverExit') },
    openViewer: () => {},
  }
  const request = { t: 'spawn' as const, id: 42, cmd: 'vspaero', args: [] }
  return { events, worker, vsp, deps, request }
}

describe('synchronous program spawn failure', () => {
  it('reports failure before worker creation', () => {
    const s = setup()
    s.deps.createWorker = () => { throw Error('worker') }
    runProgram(s.vsp, s.request, s.deps)
    expect(s.events).toEqual(['spawn', 'solverExit', 'output', 'exit:127'])
    expect(s.deps.programs.size).toBe(0)
  })
  it('records FS failure even when the solver notification throws', () => {
    const s = setup()
    s.vsp.FS.analyzePath = () => { throw Error('FS') }
    s.deps.solverSpawned = () => { s.events.push('spawn'); throw Error('notify') }
    runProgram(s.vsp, s.request, s.deps)
    expect(s.events).toEqual(['spawn', 'solverExit', 'output', 'exit:127'])
  })
  it('cleans up independently even if cleanup callbacks throw and ignores late events', () => {
    const s = setup()
    s.worker.terminate = vi.fn(() => { s.events.push('terminate'); throw Error() })
    s.worker.postMessage = vi.fn(() => { throw Error() })
    s.deps.solverExited = () => { s.events.push('solverExit'); throw Error() }
    s.vsp.processOutput = vi.fn(() => { s.events.push('output'); throw Error() })
    runProgram(s.vsp, s.request, s.deps)
    expect(s.events).toEqual(['spawn', 'terminate', 'solverExit', 'output', 'exit:127'])
    expect(s.deps.programs.size).toBe(0)
    s.worker.onmessage?.({ data: { type: 'exit', code: 0, files: [] } } as MessageEvent)
    s.worker.onerror?.({ message: 'late' } as ErrorEvent)
    expect(s.vsp.processExit).toHaveBeenCalledTimes(1)
  })
  it('treats a throwing solverSpawned as possibly already effective', () => {
    const s = setup()
    s.deps.solverSpawned = () => { throw Error() }
    runProgram(s.vsp, s.request, s.deps)
    expect(s.events).toEqual(['terminate', 'solverExit', 'output', 'exit:127'])
  })
  it('covers viewer failure and reentrant completion', () => {
    const s = setup()
    s.deps.openViewer = () => { throw Error() }
    runProgram(s.vsp, { ...s.request, cmd: 'vspviewer' }, s.deps)
    expect(s.events).toEqual(['output', 'exit:127'])
    s.deps.openViewer = (_vsp, _id, _args, exit) => { exit(0); exit(0); throw Error('after exit') }
    expect(() => runProgram(s.vsp, { ...s.request, cmd: 'vspviewer' }, s.deps)).toThrow('after exit')
    expect(s.events).toEqual(['output', 'exit:127', 'exit:0'])
  })
  it('does not promise delivery or retry when processExit throws', () => {
    const s = setup()
    s.deps.createWorker = () => { throw Error() }
    s.vsp.processExit = vi.fn(() => { throw Error('exit') })
    expect(() => runProgram(s.vsp, s.request, s.deps)).toThrow('exit')
    expect(s.vsp.processExit).toHaveBeenCalledTimes(1)
  })
  it('preserves the normal worker exit path', () => {
    const s = setup()
    runProgram(s.vsp, s.request, s.deps)
    expect(s.deps.programs.get(42)).toBe(s.worker)
    s.worker.onmessage?.({ data: { type: 'exit', code: 0, files: [] } } as MessageEvent)
    expect(s.events).toEqual(['spawn', 'terminate', 'solverExit', 'exit:0'])
    expect(s.deps.programs.size).toBe(0)
  })
})
