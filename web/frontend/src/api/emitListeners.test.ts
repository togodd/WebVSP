import { describe, expect, it, vi } from 'vitest'
import { emitListeners } from './emitListeners'
import { settleBridgeResult, type BridgePending } from './settleBridgeResult'

describe('emitListeners', () => {
  it('logs each thrown value and continues delivering the same event', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const event = { type: 'mirror_snapshot' }
      const firstError = new Error('first')
      const lastError = 'last'
      const received = vi.fn()
      const listeners = new Set([(e: typeof event) => { expect(e).toBe(event); throw firstError }, received, () => { throw lastError }])
      emitListeners(listeners, event)
      expect(received).toHaveBeenCalledExactlyOnceWith(event)
      expect(log.mock.calls).toEqual([['WebVSP event listener:', firstError], ['WebVSP event listener:', lastError]])
    } finally {
      log.mockRestore()
    }
  })

  it('contains a failing logger and reports private listener failure without exposing it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => { throw Error('logger') })
    try {
      const next = vi.fn()
      const listeners = new Set<(_: string) => void>([() => { throw Error('private path') }, next])
      expect(emitListeners(listeners, 'ordinary')).toBe(false)
      expect(emitListeners(listeners, 'dialog', true)).toBe(false)
      expect(next).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalledTimes(1)
    } finally { log.mockRestore() }
  })

  it('observes rejected promises and thenables without waiting or stopping later listeners', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const promiseError = new Error('promise')
      const thenableError = new Error('thenable')
      const next = vi.fn()
      const listeners = new Set<(_: string) => void>([
        () => Promise.reject(promiseError),
        () => ({ then: (_resolve: unknown, reject: (error: unknown) => void) => reject(thenableError) }),
        next,
      ])
      expect(emitListeners(listeners, 'event')).toBe(true)
      expect(next).toHaveBeenCalledExactlyOnceWith('event')
      expect(log).not.toHaveBeenCalled()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(log).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalledWith('WebVSP event listener:', promiseError)
      expect(log).toHaveBeenCalledWith('WebVSP event listener:', thenableError)
    } finally { log.mockRestore() }
  })

  it('assimilates a then function whose own call property is overridden', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error('then rejection')
      const then = Object.assign(function (this: unknown, _resolve: unknown, reject: (reason: unknown) => void) {
        expect(this).toBe(thenable)
        reject(error)
      }, { call: null })
      const thenable = { then }
      const next = vi.fn()
      const listeners = new Set<(_: number) => void>([() => thenable, next])
      expect(emitListeners(listeners, 0)).toBe(true)
      expect(next).toHaveBeenCalledOnce()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(log).toHaveBeenCalledExactlyOnceWith('WebVSP event listener:', error)
    } finally { log.mockRestore() }
  })

  it('reads then once synchronously and invokes it after all listeners', async () => {
    const calls: string[] = []
    const thenable = { get then() {
      calls.push('getter')
      return (resolve: (value: unknown) => void) => { calls.push('then'); resolve(undefined) }
    } }
    const listeners = new Set<(_: number) => void>([
      () => { calls.push('first'); return thenable },
      () => { calls.push('second'); return 42 },
    ])
    expect(emitListeners(listeners, 0)).toBe(true)
    expect(calls).toEqual(['first', 'getter', 'second'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['first', 'getter', 'second', 'then'])
  })

  it('reads an ordinary object then getter once but does not assimilate non-functions', () => {
    const calls: string[] = []
    const ordinary = { get then() { calls.push('getter'); return 1 } }
    const listeners = new Set<(_: number) => void>([
      () => ordinary,
      () => { calls.push('next') },
    ])
    expect(emitListeners(listeners, 0)).toBe(true)
    expect(calls).toEqual(['getter', 'next'])
  })

  it('contains throwing then getters synchronously and reads them once', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error('getter')
      const getter = vi.fn(() => { throw error })
      const next = vi.fn()
      const listeners = new Set<(_: string) => void>([() => ({ get then() { return getter() } }), next])
      expect(emitListeners(listeners, 'event')).toBe(false)
      expect(getter).toHaveBeenCalledOnce()
      expect(next).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledExactlyOnceWith('WebVSP event listener:', error)
    } finally { log.mockRestore() }
  })

  it('keeps private asynchronous failures secret and cooperates with a once-only diagnostic', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const diagnostic = vi.fn()
      let reported = false
      const report = () => { if (!reported) { reported = true; diagnostic() } }
      const next = vi.fn()
      const listeners = new Set<(_: string) => void>([
        () => { throw Error('secret sync') },
        () => Promise.reject(Error('secret async')),
        () => ({ then: () => { throw Error('secret thenable') } }),
        next,
      ])
      if (!emitListeners(listeners, 'event', true, report)) report()
      expect(diagnostic).toHaveBeenCalledOnce()
      expect(next).toHaveBeenCalledOnce()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(diagnostic).toHaveBeenCalledOnce()
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  it('retains live Set iteration, including deletion, insertion and re-addition', () => {
    const calls: string[] = []
    const listeners = new Set<(event: number) => void>()
    const removed = () => calls.push('removed')
    const added = () => calls.push('added')
    const readded = () => calls.push('readded')
    const first = () => {
      calls.push('first')
      listeners.delete(removed)
      listeners.delete(readded)
      listeners.add(added)
      listeners.add(readded)
      listeners.add(added) // Duplicate additions still produce only one call.
    }
    listeners.add(first).add(removed).add(readded)
    emitListeners(listeners, 0)
    expect(calls).toEqual(['first', 'added', 'readded'])
  })

  it('allows the rest of a representative engine batch to settle after a failed listener', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pending = new Map<number, BridgePending>()
      const result = new Promise<unknown>((resolve, reject) => pending.set(1, { resolve, reject }))
      const requestFull = vi.fn()
      const ready = vi.fn()
      const received = vi.fn()
      const listeners = new Set<(_: string) => void>([() => { throw new Error('listener') }, received])
      // Mirrors the ordering in drain: snapshot, requestFull, ready, result, mirror.
      emitListeners(listeners, 'snapshot')
      requestFull()
      ready()
      settleBridgeResult(pending, { id: 1, ok: true, value: 42 }, () => null, () => new Error())
      emitListeners(listeners, 'mirror')
      await expect(result).resolves.toBe(42)
      expect(pending.size).toBe(0)
      expect(requestFull).toHaveBeenCalledOnce()
      expect(ready).toHaveBeenCalledOnce()
      expect(received.mock.calls).toEqual([['snapshot'], ['mirror']])
      expect(log).toHaveBeenCalledTimes(2)
    } finally {
      log.mockRestore()
    }
  })
})
