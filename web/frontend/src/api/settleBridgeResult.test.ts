import { describe, expect, it, vi } from 'vitest'
import { settleBridgeResult, type BridgePending } from './settleBridgeResult'
import { drainBatch } from './drainBatch'

function request(pending: Map<number, BridgePending>, id: number) {
  return new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
}

describe('settleBridgeResult', () => {
  it('rejects an unconstructible JSON error and continues past null to the next result and mirror', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
    try {
      const { makeBridgeError, WasmEngineError } = await import('./wasmEngine')
      const pending = new Map<number, BridgePending>()
      const failed = request(pending, 1)
      const next = request(pending, 2)
      const batch = JSON.parse('{"proc":[],"out":[{"t":"result","id":1,"ok":false,"error":{"toString":null,"valueOf":null} },null,{"t":"result","id":2,"ok":true,"value":42}],"mirror":[{"t":"diff"}]}')
      const mirror = vi.fn()
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        drainBatch(batch, () => {}, (message: Record<string, unknown>) => {
          if (message.t === 'result') settleBridgeResult(pending, message, () => null, makeBridgeError)
        }, mirror)
        await expect(failed).rejects.toEqual(new Error('Invalid engine error response'))
        await expect(next).resolves.toBe(42)
        expect(pending.size).toBe(0)
        expect(mirror).toHaveBeenCalledExactlyOnceWith([{ t: 'diff' }])
        expect(log.mock.calls).toEqual([['WebVSP: output handler failed']])
        const normal = makeBridgeError({ error: 'stale', code: 'STALE_MODEL', outcome: 'different', actual: 3 })
        expect(normal).toBeInstanceOf(WasmEngineError)
        expect(normal).toMatchObject({ message: 'stale', status: 409, outcome: 'different', actual: 3, code: 'STALE_MODEL' })
      } finally {
        log.mockRestore()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects only the failed binary request and continues the batch and mirror delivery', async () => {
    const pending = new Map<number, BridgePending>()
    const first = request(pending, 1)
    const second = request(pending, 2)
    const failure = new RangeError('invalid binary payload')
    const take = vi.fn((id: number) => {
      if (id === 1) throw failure
      return new Uint8Array([7, 8])
    })
    const out = [
      { t: 'result', id: 1, ok: true, bin: true },
      { t: 'result', id: 2, ok: true, bin: true },
    ]
    const mirror = vi.fn()
    for (const result of out) settleBridgeResult(pending, result, take, () => new Error('engine'))
    mirror()
    await expect(first).rejects.toBe(failure)
    expect(new Uint8Array(await second as ArrayBuffer)).toEqual(new Uint8Array([7, 8]))
    expect(take.mock.calls).toEqual([[1], [2]])
    expect(pending.size).toBe(0)
    expect(mirror).toHaveBeenCalledOnce()
  })

  it('continues after an orphan binary extraction throws', async () => {
    const pending = new Map<number, BridgePending>()
    const next = request(pending, 2)
    const take = vi.fn((): Uint8Array | null => { throw new Error('bad orphan') })
    settleBridgeResult(pending, { id: 1, bin: true, ok: true }, take, () => new Error())
    settleBridgeResult(pending, { id: 2, ok: true, value: 42 }, take, () => new Error())
    await expect(next).resolves.toBe(42)
    expect(take).toHaveBeenCalledOnce()
    expect(pending.size).toBe(0)
  })

  it('preserves engine errors and empty binary behavior', async () => {
    const pending = new Map<number, BridgePending>()
    const failed = request(pending, 1)
    const empty = request(pending, 2)
    const engineError = new Error('engine error')
    const take = vi.fn(() => null)
    settleBridgeResult(pending, { id: 1, ok: false, bin: true }, take, () => engineError)
    settleBridgeResult(pending, { id: 2, ok: true, bin: true }, take, () => new Error())
    await expect(failed).rejects.toBe(engineError)
    await expect(empty).resolves.toEqual(new ArrayBuffer(0))
    expect(take.mock.calls).toEqual([[2]])
    expect(pending.size).toBe(0)
  })
})
