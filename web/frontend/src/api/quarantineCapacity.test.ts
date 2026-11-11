import { spawnSync } from 'node:child_process'
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
    expect(await b.commit(() => 42)).toEqual({ value: 42 })
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
    expect(await good.commit(() => 'ok')).toEqual({ value: 'ok' })
    expect(q.has('a')).toBe(true)
    expect(q.has('b')).toBe(true)
  })

  it('does not re-assimilate a mutable then getter after release', async () => {
    const q = new QuarantineCapacity(1, 10)
    const r = reserved(q.reserve(['key']))
    let reads = 0
    const value = { get then() { if (++reads > 1) throw Error('second access'); return undefined } }
    const result = await r.commit(() => value)
    expect(result.value).toBe(value)
    expect(reads).toBe(1)
    expect(q.has('key')).toBe(false)
  })

  it('commits synchronously, releases successes and retains every key on throw', () => {
    const q = new QuarantineCapacity(3, 10)
    const ok = reserved(q.reserve(['a', 'bb']))
    expect(ok.commitSync(() => {
      expect(q.has('a')).toBe(true)
    })).toBeUndefined()
    expect([q.entryCount, q.codeUnits]).toEqual([0, 0])
    expect(ok.cancel()).toBe(false)
    expect(() => ok.commitSync(() => 0)).toThrow('already used')

    const failed = reserved(q.reserve(['a', 'bb']))
    const error = new Error('transaction failed')
    expect(() => failed.commitSync(() => { throw error })).toThrow(error)
    expect([q.has('a'), q.has('bb'), q.entryCount, q.codeUnits]).toEqual([true, true, 2, 3])
    expect(failed.cancel()).toBe(false)
    expect(q.reserve(['bb'])).toEqual({ ok: false, reason: 'conflict' })
  })

  it('rejects every non-undefined result without inspecting or invoking then', () => {
    let reads = 0
    const hostile = { get then(): never { reads++; throw Error('must not read') } }
    const callable = Object.assign(() => 0, { then() { throw Error('must not run') } })
    for (const value of [Promise.resolve(1), hostile, callable, null, 42]) {
      const q = new QuarantineCapacity(2, 10)
      const r = reserved(q.reserve(['a', 'b']))
      expect(() => r.commitSync(() => value)).toThrow(TypeError)
      expect([q.status('a'), q.status('b'), q.entryCount]).toEqual(['quarantined', 'quarantined', 2])
    }
    expect(reads).toBe(0)
  })

  it('leaves rejected Promise handling to the caller, without invoking arbitrary then', () => {
    // A real child process with strict rejection handling verifies both the documented
    // failure mode and the caller-handled case, without leaking into the test runner.
    const source = `
      import { QuarantineCapacity } from ${JSON.stringify(new URL('./quarantineCapacity.ts', import.meta.url).href)};
      const q = new QuarantineCapacity(1, 1);
      const result = q.reserve(['a']);
      if (!result.ok) throw Error('reserve failed');
      const p = Promise.reject(Error('async failure'));
      if (process.argv[1] === 'handled') p.catch(() => {});
      try { result.reservation.commitSync(() => p); throw Error('missing TypeError'); }
      catch (e) { if (!(e instanceof TypeError)) throw e; }
      if (q.status('a') !== 'quarantined') throw Error('not quarantined');
      setImmediate(() => {});
    `
    const args = ['--experimental-strip-types', '--unhandled-rejections=strict', '--input-type=module', '-e', source]
    const handled = spawnSync(process.execPath, [...args, 'handled'], { encoding: 'utf8' })
    expect(handled.error).toBeUndefined()
    expect(handled.status, handled.stderr).toBe(0)
    const unhandled = spawnSync(process.execPath, [...args, 'unhandled'], { encoding: 'utf8' })
    expect(unhandled.error).toBeUndefined()
    expect(unhandled.status).not.toBe(0)
    expect(unhandled.stderr).toContain('async failure')
  })

  it('shares single-use state across sync and async commits', async () => {
    const q = new QuarantineCapacity(2, 10)
    const cancelled = reserved(q.reserve(['a']))
    expect(cancelled.cancel()).toBe(true)
    expect(() => cancelled.commitSync(() => 1)).toThrow('already used')
    const pending = reserved(q.reserve(['b']))
    let finish!: () => void
    const wait = new Promise<void>(resolve => { finish = resolve })
    const result = pending.commit(async () => { await wait; return 1 })
    expect(() => pending.commitSync(() => 2)).toThrow('already used')
    finish()
    await expect(result).resolves.toEqual({ value: 1 })
    expect(() => pending.commitSync(() => 2)).toThrow('already used')
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
