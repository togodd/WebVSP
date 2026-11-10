import { describe, expect, it, vi } from 'vitest'
import { submitPending } from './pendingCall'

describe('pending engine requests', () => {
  it('removes a synchronously failing submission and rejects with the original error', async () => {
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
    const other = { resolve: vi.fn(), reject: vi.fn() }
    pending.set(2, other)
    const error = new Error('submission failed')
    const request = submitPending(pending, 1, () => {
      expect(pending.has(1)).toBe(true)
      throw error // The engine may already have queued the operation.
    })
    expect(pending.has(1)).toBe(false)
    expect(pending.get(2)).toBe(other)
    await expect(request).rejects.toBe(error)
    expect(error).not.toHaveProperty('outcome', 'not_written')

  })

  it('keeps a successful submission pending until its result is delivered', async () => {
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
    const request = submitPending(pending, 3, () => expect(pending.has(3)).toBe(true))
    const entry = pending.get(3)
    expect(entry).toBeDefined()
    pending.delete(3)
    entry!.resolve('result')
    await expect(request).resolves.toBe('result')
  })
})
