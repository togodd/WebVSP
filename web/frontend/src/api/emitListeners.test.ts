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
