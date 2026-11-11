import { describe, expect, it, vi } from 'vitest'
import { SerialCoordinator } from './serialCoordinator'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

describe('SerialCoordinator', () => {
  it('runs concurrent work and a barrier in FIFO order without overlap', async () => {
    const gate = new SerialCoordinator()
    const first = deferred<void>()
    const barrier = deferred<void>()
    const events: string[] = []
    const a = gate.run(async () => { events.push('a start'); await first.promise; events.push('a end'); return 1 })
    const b = gate.barrier(async () => { events.push('barrier start'); await barrier.promise; events.push('barrier end'); return 2 })
    const c = gate.run(() => { events.push('c'); return 3 })
    await Promise.resolve()
    expect(events).toEqual(['a start'])
    first.resolve()
    expect(await a).toBe(1)
    // Allow the queue's completion handler and next task to run.
    await vi.waitFor(() => expect(events).toEqual(['a start', 'a end', 'barrier start']))
    barrier.resolve()
    expect(await b).toBe(2)
    expect(await c).toBe(3)
    expect(events).toEqual(['a start', 'a end', 'barrier start', 'barrier end', 'c'])
  })

  it('propagates a synchronous throw and continues the queue', async () => {
    const gate = new SerialCoordinator()
    const error = new Error('sync')
    const failed = gate.run(() => { throw error })
    const next = gate.barrier(() => 'next')
    await expect(failed).rejects.toBe(error)
    await expect(next).resolves.toBe('next')
  })

  it('propagates asynchronous rejection and continues only after it settles', async () => {
    const gate = new SerialCoordinator()
    const pending = deferred<void>()
    const error = new Error('async')
    const nextTask = vi.fn(() => 'next')
    const failed = gate.barrier(() => pending.promise)
    const next = gate.run(nextTask)
    await Promise.resolve()
    expect(nextTask).not.toHaveBeenCalled()
    pending.reject(error)
    await expect(failed).rejects.toBe(error)
    await expect(next).resolves.toBe('next')
  })

  it('does not release a hung task when its caller stops waiting', async () => {
    const gate = new SerialCoordinator()
    const pending = deferred<void>()
    const later = vi.fn()
    const running = gate.barrier(() => pending.promise)
    const after = gate.run(later)
    const abandonedWait = await Promise.race([running.then(() => 'done'), Promise.resolve('timed out')])
    expect(abandonedWait).toBe('timed out')
    await Promise.resolve()
    await Promise.resolve()
    expect(later).not.toHaveBeenCalled()
    pending.resolve()
    await running
    await after
    expect(later).toHaveBeenCalledOnce()
  })
})
