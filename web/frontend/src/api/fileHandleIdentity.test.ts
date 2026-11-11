import { describe, expect, it, vi } from 'vitest'
import { compareFileHandles } from './fileHandleIdentity'

const handle = (answer: unknown) => ({ isSameEntry: vi.fn(async (_other: any) => answer as boolean) })

describe('file handle identity evidence', () => {
  it('recognizes the same object without invoking a comparator', async () => {
    const a = handle(false)
    expect(await compareFileHandles(a, a)).toBe('same')
    expect(a.isSameEntry).not.toHaveBeenCalled()
  })

  it.each([[true, true, 'same'], [false, false, 'different'], [true, false, 'unknown'], [false, true, 'unknown'], [undefined, true, 'unknown']] as const)(
    'requires consistent boolean answers (%s, %s)', async (left, right, expected) => {
      const a = handle(left), b = handle(right)
      expect(await compareFileHandles(a, b)).toBe(expected)
      expect(a.isSameEntry).toHaveBeenCalledWith(b)
      expect(b.isSameEntry).toHaveBeenCalledWith(a)
      expect(await compareFileHandles(b, a)).toBe(expected)
    },
  )

  it('fails closed for missing methods, throwing getters and rejections', async () => {
    const a = handle(true)
    const missing = {} as typeof a
    const getter = Object.defineProperty({}, 'isSameEntry', { get() { throw new Error('private') } }) as typeof a
    const rejecting = { isSameEntry: vi.fn(async () => { throw new Error('private') }) }
    expect(await compareFileHandles(a, missing)).toBe('unknown')
    expect(await compareFileHandles(a, getter)).toBe('unknown')
    expect(await compareFileHandles(a, rejecting)).toBe('unknown')
  })

  it.each(['left', 'right'] as const)('returns unknown on %s rejection without canceling the other comparison', async side => {
    let finish!: (value: boolean) => void
    const pending = vi.fn(() => new Promise<boolean>(r => { finish = r }))
    const fail = vi.fn(async () => { throw new Error('private') })
    const a = { isSameEntry: side === 'left' ? fail : pending }
    const b = { isSameEntry: side === 'right' ? fail : pending }
    expect(await compareFileHandles(a, b)).toBe('unknown')
    expect(pending).toHaveBeenCalledOnce()
    finish(true)
  })

  it('does not promise order-independent results for stateful handles', async () => {
    let count = 0
    const a = { isSameEntry: async () => { count++; return true } }
    const b = { isSameEntry: async () => count === 1 }
    expect(await compareFileHandles(a, b)).toBe('same')
    count = 0
    expect(await compareFileHandles(b, a)).toBe('unknown')
  })

  it('waits for both comparisons instead of inferring from the first', async () => {
    let resolve!: (value: boolean) => void
    const a = handle(true), b = { isSameEntry: vi.fn(() => new Promise<boolean>(r => { resolve = r })) }
    let settled = false
    const result = compareFileHandles(a, b).then(value => { settled = true; return value })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    resolve(true)
    expect(await result).toBe('same')
  })
})
