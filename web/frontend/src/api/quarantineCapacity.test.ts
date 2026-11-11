import { describe, expect, it } from 'vitest'
import { QuarantineCapacity, type QuarantineReservation } from './quarantineCapacity'

function reserved(result: ReturnType<QuarantineCapacity['reserve']>): QuarantineReservation {
  if (!result.ok) throw Error(`reservation failed: ${result.reason}`)
  return result.reservation
}

describe('QuarantineCapacity', () => {
  it('validates limits, inputs, duplicates and UTF-16 boundaries atomically', () => {
    for (const n of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new QuarantineCapacity(n, 1)).toThrow(RangeError)
      expect(() => new QuarantineCapacity(1, n)).toThrow(RangeError)
    }
    const q = new QuarantineCapacity(3, 4)
    expect(q.reserve([])).toEqual({ ok: false, reason: 'invalid' })
    expect(q.reserve(['a', 'a'])).toEqual({ ok: false, reason: 'duplicate' })
    expect(q.reserve([''])).toEqual({ ok: false, reason: 'invalid' })
    expect(q.reserve(['😀', 'abc'])).toEqual({ ok: false, reason: 'capacity' })
    expect(q.entryCount).toBe(0)
    const r = reserved(q.reserve(['😀', 'ab']))
    expect([q.entryCount, q.codeUnits]).toEqual([2, 4])
    expect(q.reserve(['c'])).toEqual({ ok: false, reason: 'capacity' })
    expect(q.reserve(['ab'])).toEqual({ ok: false, reason: 'conflict' })
    expect(r.cancel()).toBe(true)
    expect(r.cancel()).toBe(false)
    expect([q.entryCount, q.codeUnits]).toEqual([0, 0])
  })

  it('reserves across concurrent commits, retains entire failed batch and releases success', async () => {
    const q = new QuarantineCapacity(3, 10)
    let finish!: () => void
    const wait = new Promise<void>(resolve => { finish = resolve })
    const a = reserved(q.reserve(['a', 'bb']))
    const committing = a.commit(async () => { await wait; throw Error('failed') })
    expect(a.cancel()).toBe(false)
    await expect(a.commit(() => 1)).rejects.toThrow('already used')
    expect(q.reserve(['bb'])).toEqual({ ok: false, reason: 'conflict' })
    const b = reserved(q.reserve(['c']))
    expect(q.reserve(['d'])).toEqual({ ok: false, reason: 'capacity' })
    expect(await b.commit(() => 42)).toBe(42)
    finish()
    await expect(committing).rejects.toThrow('failed')
    expect([q.entryCount, q.codeUnits]).toEqual([2, 3])
    expect(q.has('a')).toBe(true)
    expect(q.has('bb')).toBe(true)
    expect(q.has('c')).toBe(false)
    expect(q.reserve(['a'])).toEqual({ ok: false, reason: 'conflict' })
  })

  it('handles reentrancy and hostile input or thenables without losing isolation', async () => {
    const q = new QuarantineCapacity(4, 20)
    const bad = ['x', 'y']
    Object.defineProperty(bad, 1, { get() { throw Error('getter') } })
    expect(q.reserve(bad)).toEqual({ ok: false, reason: 'invalid' })
    expect(q.entryCount).toBe(0)
    const reentrant = ['a']
    Object.defineProperty(reentrant, 0, { get() { reserved(q.reserve(['a'])); return 'a' } })
    expect(q.reserve(reentrant)).toEqual({ ok: false, reason: 'conflict' })
    const r = reserved(q.reserve(['b', 'c']))
    await expect(r.commit(() => {
      expect(q.reserve(['b'])).toEqual({ ok: false, reason: 'conflict' })
      expect(r.cancel()).toBe(false)
      return { get then(): never { throw Error('then') } } as PromiseLike<never>
    })).rejects.toThrow('then')
    expect(q.has('b')).toBe(true)
    expect(q.has('c')).toBe(true)
    const good = reserved(q.reserve(['d']))
    expect(await good.commit(() => 'ok')).toBe('ok')
    expect(q.has('a')).toBe(true)
    expect(q.has('b')).toBe(true)
  })

  it('preserves failed keys under repeated capacity pressure and releases successes', async () => {
    const q = new QuarantineCapacity(64, 1024)
    for (let i = 0; i < 64; i++) {
      const key = `key${i}`
      const r = reserved(q.reserve([key]))
      await expect(r.commit(() => { throw Error('failure') })).rejects.toThrow('failure')
    }
    for (let i = 0; i < 1000; i++) {
      expect(q.reserve([`extra${i}`])).toEqual({ ok: false, reason: 'capacity' })
      expect(q.has(`key${i % 64}`)).toBe(true)
    }
    expect(q.entryCount).toBe(64)
    const reusable = new QuarantineCapacity(1, 1)
    for (let i = 0; i < 1000; i++) await reserved(reusable.reserve(['x'])).commit(() => i)
    expect([reusable.entryCount, reusable.codeUnits]).toEqual([0, 0])
  })
})
