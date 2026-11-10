import { describe, expect, it, vi } from 'vitest'
import { facadeSubmit } from './facadeSubmit'
import { submitPending } from './pendingCall'
import { settleBridgeResult } from './settleBridgeResult'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('facade startup submission', () => {
  it.each(['load', 'ready'] as const)('does not submit after close during %s; another session continues', async (stage) => {
    const load = deferred<string>(), ready = deferred<void>()
    const first = new AbortController(), second = new AbortController()
    const submit = vi.fn(async (module: string) => module)
    const a = facadeSubmit(first.signal, () => load.promise, ready.promise, submit)
    const b = facadeSubmit(second.signal, () => load.promise, ready.promise, submit)
    if (stage === 'ready') { load.resolve('engine'); await Promise.resolve(); await Promise.resolve() }
    first.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    load.resolve('engine'); ready.resolve()
    await expect(b).resolves.toBe('engine')
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('retains submitted pending entries until late results arrive', async () => {
    const controller = new AbortController()
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
    const submitted = deferred<void>()
    const result = facadeSubmit(controller.signal, async () => 'engine', Promise.resolve(), () => {
      const p = submitPending(pending, 1, () => submitted.resolve())
      return p
    })
    await submitted.promise
    controller.abort()
    expect(pending.has(1)).toBe(true)
    settleBridgeResult(pending, { id: 1, ok: true, value: 'late' }, () => null, () => new Error())
    await expect(result).resolves.toBe('late')
    expect(pending.size).toBe(0)
  })

  it('shares one startup reaction and removes each aborted subscription', async () => {
    const load = deferred<string>(), ready = deferred<void>()
    const then = vi.spyOn(load.promise, 'then')
    const controllers = Array.from({ length: 10 }, () => new AbortController())
    const removals = controllers.map((c) => vi.spyOn(c.signal, 'removeEventListener'))
    const calls = controllers.map((c) => facadeSubmit(c.signal, () => load.promise, ready.promise, async () => 1))
    controllers.forEach((c) => c.abort())
    await Promise.all(calls.map((p) => expect(p).rejects.toMatchObject({ name: 'AbortError' })))
    expect(then).toHaveBeenCalledTimes(1)
    for (const removal of removals) expect(removal).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('observes load rejection even if load synchronously closes the handle', async () => {
    const controller = new AbortController(), submit = vi.fn()
    const load = () => { controller.abort(); return Promise.reject(new Error('load failed')) }
    await expect(facadeSubmit(controller.signal, load, Promise.resolve(), submit)).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(submit).not.toHaveBeenCalled()
  })

  it('observes readiness rejection while load is still pending', async () => {
    const load = deferred<string>(), ready = deferred<void>()
    const controller = new AbortController(), submit = vi.fn()
    const result = facadeSubmit(controller.signal, () => load.promise, ready.promise, submit)
    ready.reject(new Error('ready failed'))
    await Promise.resolve()
    load.resolve('engine')
    await expect(result).rejects.toThrow('ready failed')
    expect(submit).not.toHaveBeenCalled()
  })

  it('consumes a late startup failure after close', async () => {
    const load = deferred<string>()
    const controller = new AbortController()
    const submit = vi.fn()
    const result = facadeSubmit(controller.signal, () => load.promise, Promise.resolve(), submit)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    load.reject(new Error('late'))
    await Promise.resolve()
    expect(submit).not.toHaveBeenCalled()
  })
})
