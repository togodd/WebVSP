/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { BindingLifecycle } from './bindingLifecycle'

describe('BindingLifecycle (standalone lane)', () => {
  it('validates and copies quota configuration', () => {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new BindingLifecycle({ maxSnapshots: value, maxBytes: 0 })).toThrow(RangeError)
      expect(() => new BindingLifecycle({ maxSnapshots: 0, maxBytes: value })).toThrow(RangeError)
    }
    const limits = { maxSnapshots: 1, maxBytes: 1 }
    const model = new BindingLifecycle(limits)
    limits.maxSnapshots = 100
    const binding = model.bind('/a')
    model.capture(binding, new Uint8Array(1))
    expect(() => model.capture(binding, new Uint8Array(0))).toThrow('quota')
  })

  it('accounts for every terminal state until explicitly released', () => {
    const model = new BindingLifecycle({ maxSnapshots: 3, maxBytes: 6 })
    const a = model.bind('/a')
    const done = model.capture(a, new Uint8Array([1, 2]))
    const failed = model.capture(a, new Uint8Array([3, 4]))
    const discarded = model.capture(a, new Uint8Array([5, 6]))
    model.start(done)
    model.closeStarted(done)
    model.complete(done)
    model.start(failed)
    model.fail(failed, 'failure')
    model.invalidate(a)
    const b = model.bind('/b')
    expect(() => model.capture(b, new Uint8Array())).toThrow('quota')
    expect(model.failure(failed)).toBe('failure')
    expect([...model.bytes(discarded)]).toEqual([5, 6])
    model.release(done)
    const replacement = model.capture(b, new Uint8Array([7, 8]))
    expect(() => model.capture(b, new Uint8Array())).toThrow('quota')
    model.release(failed)
    model.release(discarded)
    expect(() => model.status(failed)).toThrow('unknown snapshot')
    expect(() => model.bytes(done)).toThrow('unknown snapshot')
    expect(() => model.release(done)).toThrow('unknown snapshot')
    expect(model.status(replacement)).toBe('pending')
  })

  it('enforces byte quota independently, preserving existing snapshots on rejection', () => {
    const model = new BindingLifecycle({ maxSnapshots: 10, maxBytes: 3 })
    const binding = model.bind('/a')
    const first = model.capture(binding, new Uint8Array([1, 2]))
    expect(() => model.capture(binding, new Uint8Array([3, 4]))).toThrow('quota')
    expect([...model.bytes(first)]).toEqual([1, 2])
    const second = model.capture(binding, new Uint8Array([3]))
    expect(second.sequence).toBe(first.sequence + 1n)
    expect(model.start(first)).toBe(true)
    model.fail(first, 'failed')
    expect(() => model.capture(binding, new Uint8Array([4]))).toThrow('quota')
    model.release(first)
    expect([...model.bytes(model.capture(binding, new Uint8Array([4, 5]))) ]).toEqual([4, 5])
    expect(model.start(second)).toBe(true)
  })

  it('rejects releasing pending, started, closing and forged tokens', () => {
    const model = new BindingLifecycle({ maxSnapshots: 1, maxBytes: 1 })
    const binding = model.bind('/a')
    const snapshot = model.capture(binding, new Uint8Array([1]))
    expect(() => model.release({ ...snapshot })).toThrow('unknown snapshot')
    expect(() => model.release(snapshot)).toThrow('not releasable')
    model.start(snapshot)
    expect(() => model.release(snapshot)).toThrow('not releasable')
    model.closeStarted(snapshot)
    expect(() => model.release(snapshot)).toThrow('not releasable')
    expect(() => model.capture(binding, new Uint8Array())).toThrow('quota')
    model.complete(snapshot)
    model.release(snapshot)
    expect(model.capture(binding, new Uint8Array([2])).sequence).toBe(snapshot.sequence + 1n)
  })

  it('supports zero limits and empty snapshots', () => {
    const noSnapshots = new BindingLifecycle({ maxSnapshots: 0, maxBytes: 10 })
    expect(() => noSnapshots.capture(noSnapshots.bind('/'), new Uint8Array())).toThrow('quota')
    const noBytes = new BindingLifecycle({ maxSnapshots: 1, maxBytes: 0 })
    const binding = noBytes.bind('/')
    expect(() => noBytes.capture(binding, new Uint8Array([1]))).toThrow('quota')
    expect(noBytes.capture(binding, new Uint8Array()).sequence).toBe(1n)
  })
  it('copies captured bytes and returns copies, with immutable generation metadata', () => {
    const model = new BindingLifecycle()
    const binding = model.bind('/a')
    const input = new Uint8Array([1, 2, 3])
    const first = model.capture(binding, input)
    input[0] = 9
    const copy = model.bytes(first)
    copy[1] = 9
    expect([...model.bytes(first)]).toEqual([1, 2, 3])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(model.capture(binding, input).sequence).toBeGreaterThan(first.sequence)
  })

  it('does not invoke a malicious iterator or overridden length during capture', () => {
    const model = new BindingLifecycle({ maxSnapshots: 2, maxBytes: 2 })
    const binding = model.bind('/a')
    const input = new Uint8Array([1, 2])
    input[Symbol.iterator] = function* () {
      model.bind('/a')
      while (true) yield 9
    }
    Object.defineProperty(input, 'length', { get() { throw new Error('reentered') } })
    const snapshot = model.capture(binding, input)
    expect([...model.bytes(snapshot)]).toEqual([1, 2])
    expect(model.start(snapshot)).toBe(true)
  })

  it('copies only the selected subarray, including across realms', () => {
    const model = new BindingLifecycle({ maxSnapshots: 2, maxBytes: 4 })
    const binding = model.bind('/a')
    const local = new Uint8Array([9, 1, 2, 9]).subarray(1, 3)
    const foreign = runInNewContext('new Uint8Array([9, 3, 4, 9]).subarray(1, 3)') as Uint8Array
    expect([...model.bytes(model.capture(binding, local))]).toEqual([1, 2])
    expect([...model.bytes(model.capture(binding, foreign))]).toEqual([3, 4])
  })

  it('rejects detached input without consuming quota or sequence', () => {
    const model = new BindingLifecycle({ maxSnapshots: 1, maxBytes: 1 })
    const binding = model.bind('/a')
    const input = new Uint8Array([1])
    structuredClone(input.buffer, { transfer: [input.buffer] })
    expect(() => model.capture(binding, input)).toThrow()
    expect(model.capture(binding, new Uint8Array([2])).sequence).toBe(1n)
  })

  it('rejects out-of-bounds resizable buffer views when supported', () => {
    const ResizableArrayBuffer = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ArrayBuffer & { resize?: (length: number) => void }
    const buffer = new ResizableArrayBuffer(4, { maxByteLength: 8 })
    if (typeof buffer.resize !== 'function') return
    const input = new Uint8Array(buffer, 2, 2)
    buffer.resize(1)
    const model = new BindingLifecycle({ maxSnapshots: 1, maxBytes: 1 })
    const binding = model.bind('/a')
    expect(() => model.capture(binding, input)).toThrow()
    expect(model.capture(binding, new Uint8Array([2])).sequence).toBe(1n)
  })

  it('captures a SharedArrayBuffer view at a caller-provided synchronization boundary', () => {
    if (typeof SharedArrayBuffer === 'undefined') return
    const model = new BindingLifecycle({ maxSnapshots: 1, maxBytes: 2 })
    const input = new Uint8Array(new SharedArrayBuffer(4), 1, 2)
    input.set([1, 2])
    const snapshot = model.capture(model.bind('/a'), input)
    input[0] = 9
    expect([...model.bytes(snapshot)]).toEqual([1, 2])
  })

  it('rejects proxies and other typed-array types without invoking traps', () => {
    const model = new BindingLifecycle()
    const binding = model.bind('/a')
    const proxy = new Proxy(new Uint8Array([1]), { get() { throw new Error('trap') } })
    expect(() => model.capture(binding, proxy)).toThrow('expected Uint8Array')
    expect(() => model.capture(binding, new Int8Array([1]) as unknown as Uint8Array)).toThrow('expected Uint8Array')
    expect(model.capture(binding, new Uint8Array([2])).sequence).toBe(1n)
  })

  it('keeps the new pending snapshot unchanged when a started old operation fails', () => {
    const model = new BindingLifecycle()
    const old = model.bind('/a')
    const running = model.capture(old, new Uint8Array([1]))
    expect(model.start(running)).toBe(true)
    const current = model.bind('/a')
    const pending = model.capture(current, new Uint8Array([2]))
    expect(model.start(pending)).toBe(false)
    model.fail(running, 'write failed')
    expect(model.status(running)).toBe('failed')
    expect(model.status(pending)).toBe('pending')
    expect([...model.bytes(pending)]).toEqual([2])
    expect(model.start(pending)).toBe(true)
  })

  it('invalidates pending snapshots and never reuses a binding generation', () => {
    const model = new BindingLifecycle()
    const old = model.bind('/a')
    const pending = model.capture(old, new Uint8Array([1]))
    const current = model.bind('/a')
    expect(current.id).not.toBe(old.id)
    expect(model.status(pending)).toBe('discarded')
    expect(model.start(pending)).toBe(false)
    expect(model.invalidate(old)).toBe(false)
    expect(() => model.capture(old, new Uint8Array())).toThrow()
    expect(model.start(model.capture(current, new Uint8Array()))).toBe(true)
  })

  it('keeps an issued close busy through rebind and reports late completion only on the old snapshot', () => {
    const model = new BindingLifecycle()
    const old = model.bind('/a')
    const running = model.capture(old, new Uint8Array([1]))
    expect(model.start(running)).toBe(true)
    model.closeStarted(running)
    const current = model.bind('/a')
    const next = model.capture(current, new Uint8Array([2]))
    // A UI timeout or an invalidation is not an operation settlement.
    expect(model.isBusy()).toBe(true)
    expect(model.start(next)).toBe(false)
    expect(model.status(running)).toBe('closing')
    model.complete(running)
    expect(model.status(running)).toBe('completed')
    expect(model.status(next)).toBe('pending')
    expect(model.start(next)).toBe(true)
  })

  it('holds the lane until rejected close and required cleanup both settle; ignores no stale completion', async () => {
    const model = new BindingLifecycle()
    const old = model.bind('/a')
    const running = model.capture(old, new Uint8Array([1]))
    model.start(running)
    model.closeStarted(running)
    let rejectClose!: (reason: Error) => void
    const close = new Promise<void>((_, reject) => { rejectClose = reject })
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    const settlement = close.catch(async () => {
      await cleanup
      model.fail(running, 'close failed after cleanup')
    })
    const current = model.bind('/a')
    const next = model.capture(current, new Uint8Array([2]))
    rejectClose(new Error('close failed'))
    await Promise.resolve()
    expect(model.status(running)).toBe('closing')
    expect(model.start(next)).toBe(false)
    finishCleanup()
    await settlement
    expect(model.start(next)).toBe(true)
    expect(() => model.complete(running)).toThrow()
    expect(() => model.fail(running, 'late')).toThrow()
    expect(model.status(next)).toBe('started')
    expect(model.isBusy()).toBe(true)
  })

  it('retains started operations after invalidation, including explicit failure and bytes', () => {
    const model = new BindingLifecycle()
    const old = model.bind('/a')
    const running = model.capture(old, new Uint8Array([7]))
    model.start(running)
    model.invalidate(old)
    expect(model.isBusy()).toBe(true)
    model.fail(running, 'write failed; disk state unknown')
    expect(model.status(running)).toBe('failed')
    expect(model.failure(running)).toContain('unknown')
    expect([...model.bytes(running)]).toEqual([7])
    expect(model.isBusy()).toBe(false)
  })

  it('requires explicit legal transitions and rejects forged or duplicate notifications', () => {
    const model = new BindingLifecycle()
    const snapshot = model.capture(model.bind('/a'), new Uint8Array())
    expect(() => model.start({ ...snapshot })).toThrow('unknown snapshot')
    expect(() => model.complete(snapshot)).toThrow()
    expect(() => model.fail(snapshot, 'bad')).toThrow()
    expect(model.start(snapshot)).toBe(true)
    expect(() => model.complete(snapshot)).toThrow()
    model.closeStarted(snapshot)
    expect(() => model.closeStarted(snapshot)).toThrow()
    model.fail(snapshot, 'close failed')
    expect(() => model.complete(snapshot)).toThrow()
    expect(model.status(snapshot)).toBe('failed')
  })

  it('starts pending snapshots in lane sequence order across bindings', () => {
    const model = new BindingLifecycle()
    const a = model.bind('/a')
    const b = model.bind('/b')
    const first = model.capture(a, new Uint8Array([1]))
    const second = model.capture(b, new Uint8Array([2]))
    const third = model.capture(b, new Uint8Array([3]))
    expect(model.start(second)).toBe(false)
    expect(model.start(third)).toBe(false)
    expect(model.start(first)).toBe(true)
    model.fail(first, 'failed')
    expect(model.start(third)).toBe(false)
    expect(model.start(second)).toBe(true)
    model.closeStarted(second)
    model.complete(second)
    expect(model.start(third)).toBe(true)
    expect([...model.bytes(first)]).toEqual([1])
    expect(model.failure(first)).toBe('failed')
  })

  it('does not let discarded earlier snapshots block the lane', () => {
    const model = new BindingLifecycle()
    const a = model.bind('/a')
    const b = model.bind('/b')
    const old = model.capture(a, new Uint8Array())
    const next = model.capture(b, new Uint8Array())
    model.invalidate(a)
    expect(model.status(old)).toBe('discarded')
    expect(model.start(next)).toBe(true)
  })

  it('does not equate paths or claim physical target identity', () => {
    const model = new BindingLifecycle()
    const a = model.bind('/a')
    const b = model.bind('/b')
    const one = model.capture(a, new Uint8Array([1]))
    const two = model.capture(b, new Uint8Array([2]))
    expect(model.start(one)).toBe(true)
    expect(model.start(two)).toBe(false)
    model.closeStarted(one)
    model.complete(one)
    expect(model.start(two)).toBe(true)
  })
})
