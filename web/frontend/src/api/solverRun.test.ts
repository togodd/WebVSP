import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('VSPAERO run tracking', () => {
  it.each([0, 143, 127])('reports the actual exit code %i after the button deactivates', async (code) => {
    const run = await import('./solverRun')
    const listener = vi.fn()
    run.onSolverEnded(listener)
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200)
    // OpenVSP can spawn before the mirror activates Kill Solver.
    run.solverSpawned(1)
    run.setSolverRunning(true)
    run.setSolverRunning(true)
    run.solverExited(1, code)
    expect(listener).not.toHaveBeenCalled()
    run.setSolverRunning(false)
    run.setSolverRunning(false)
    expect(run.useSolverRun.getState()).toEqual({ start: 100, end: 200, code })
    expect(listener).toHaveBeenCalledExactlyOnceWith(code)
  })

  it('reports a missing exit code as unknown, never success', async () => {
    const run = await import('./solverRun')
    const listener = vi.fn()
    run.onSolverEnded(listener)
    run.setSolverRunning(true)
    run.solverSpawned(1)
    run.setSolverRunning(false)
    expect(run.useSolverRun.getState().code).toBeNull()
    expect(listener).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('restores the previous run after button flicker without a spawn', async () => {
    const run = await import('./solverRun')
    const listener = vi.fn()
    run.onSolverEnded(listener)
    run.setSolverRunning(true)
    run.solverSpawned(1)
    run.solverExited(1, 0)
    run.setSolverRunning(false)
    const previous = run.useSolverRun.getState()
    run.setSolverRunning(true)
    run.setSolverRunning(false)
    expect(run.useSolverRun.getState()).toEqual(previous)
    expect(listener).toHaveBeenCalledExactlyOnceWith(0)
  })

  it.each(['between', 'before-spawn', 'after-spawn'] as const)(
    'ignores a previous run exit arriving %s in the next run', async (when) => {
      const run = await import('./solverRun')
      const listener = vi.fn()
      run.onSolverEnded(listener)
      run.solverSpawned(1)
      run.setSolverRunning(true)
      run.setSolverRunning(false)
      if (when === 'between') run.solverExited(1, 0)
      run.setSolverRunning(true)
      if (when === 'before-spawn') run.solverExited(1, 0)
      run.solverSpawned(2)
      if (when === 'after-spawn') run.solverExited(1, 0)
      run.setSolverRunning(false)
      expect(listener.mock.calls).toEqual([[null], [null]])
    },
  )

  it('accepts the matching exit after a late prior exit', async () => {
    const run = await import('./solverRun')
    const listener = vi.fn()
    run.onSolverEnded(listener)
    run.solverSpawned(1)
    run.setSolverRunning(true)
    run.setSolverRunning(false)
    run.solverSpawned(2) // may precede the GUI active event
    run.solverExited(1, 0)
    run.solverExited(2, 143)
    run.setSolverRunning(true)
    run.setSolverRunning(false)
    expect(listener.mock.calls).toEqual([[null], [143]])
  })

  it('treats multiple distinct spawns in one GUI interval as unknown', async () => {
    const run = await import('./solverRun')
    const listener = vi.fn()
    run.onSolverEnded(listener)
    run.setSolverRunning(true)
    run.solverSpawned(1)
    run.solverExited(1, 0)
    run.solverSpawned(2)
    run.solverExited(2, 0)
    run.setSolverRunning(false)
    expect(listener).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('does not reuse the preceding run exit code', async () => {
    const run = await import('./solverRun')
    const listener = vi.fn()
    run.onSolverEnded(listener)
    run.solverSpawned(1)
    run.solverExited(1, 0)
    run.setSolverRunning(true)
    run.setSolverRunning(false)
    run.setSolverRunning(true)
    run.solverSpawned(2)
    run.setSolverRunning(false)
    expect(listener.mock.calls).toEqual([[0], [null]])
  })
})
