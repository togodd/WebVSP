import { describe, expect, it } from 'vitest'
import { BindingLifecycle } from './bindingLifecycle'

describe('BindingLifecycle (standalone lane)', () => {
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

  it('rechecks binding after a reentrant input iterator and does not leave a stale pending snapshot', () => {
    const model = new BindingLifecycle()
    const old = model.bind('/a')
    const input = new Uint8Array([1])
    let current = old
    input[Symbol.iterator] = function* () {
      current = model.bind('/a')
      yield 1
      return undefined
    }
    expect(() => model.capture(old, input)).toThrow('binding is not current')
    const next = model.capture(current, new Uint8Array([2]))
    expect(model.start(next)).toBe(true)
  })

  it('assigns sequence after reentrant capture so sequence matches FIFO insertion order', () => {
    const model = new BindingLifecycle()
    const binding = model.bind('/a')
    const input = new Uint8Array([1])
    let inner: ReturnType<typeof model.capture> | undefined
    input[Symbol.iterator] = function* () {
      inner = model.capture(binding, new Uint8Array([2]))
      yield 1
      return undefined
    }
    const outer = model.capture(binding, input)
    expect(inner).toBeDefined()
    if (!inner) throw new Error('iterator did not run')
    expect(inner.sequence).toBeLessThan(outer.sequence)
    expect(model.start(outer)).toBe(false)
    expect(model.start(inner)).toBe(true)
    model.closeStarted(inner)
    model.complete(inner)
    expect(model.start(outer)).toBe(true)
  })

  it('leaves no partial snapshot when copying throws', () => {
    const model = new BindingLifecycle()
    const binding = model.bind('/a')
    const input = new Uint8Array([1])
    input[Symbol.iterator] = function* () { yield 1; throw new Error('copy failed') }
    expect(() => model.capture(binding, input)).toThrow('copy failed')
    const next = model.capture(binding, new Uint8Array([2]))
    expect(next.sequence).toBe(1n)
    expect(model.start(next)).toBe(true)
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
