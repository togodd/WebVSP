import { describe, expect, it, vi } from 'vitest'
import { settleBridgeResult, type BridgePending } from './settleBridgeResult'
import { drainBatch } from './drainBatch'

function request(pending: Map<number, BridgePending>, id: number) {
  return new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
}

describe('settleBridgeResult', () => {
  it('rejects a malformed JSON error and continues past null to the next result and mirror', async () => {
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
        await expect(failed).rejects.toEqual(new Error('Invalid engine result response'))
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

  it('does not trust malformed bridge results as parameter write outcomes', async () => {
    const { makeBridgeError, WasmEngineError } = await import('./wasmEngine')
    const { createParameterWriteService } = await import('../modeling/parameterWriteService')
    const input = { owner: 'geometry' as const, ownerId: 'geom', parameterId: 'parm', value: 1.5 }
    const identity = { sessionId: 'session', modelEpoch: '42' }
    const malformed = [
      ...[undefined, null, 0, 1, '', 'false', 'true', {}, []].map(ok => ({ ok, error: 'stale' })),
      ...[undefined, null, 0, 1, true, {}, []].map(error => ({ ok: false, error })),
    ]
    const trustedMetadata = { code: 'STALE_MODEL', outcome: 'not_written', actual: null }
    for (const fields of malformed) {
      const pending = new Map<number, BridgePending>()
      let bridgeError: unknown
      const adapter = {
        set: () => {
          const result = request(pending, 1).catch(error => { bridgeError = error; throw error })
          settleBridgeResult(pending, { id: 1, ...trustedMetadata, value: { actual: 1.5 }, ...fields }, () => null, makeBridgeError)
          return result as Promise<{ actual: number }>
        },
      }
      await expect(createParameterWriteService(adapter).set(input, identity)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      expect(bridgeError).toBeInstanceOf(Error)
      expect(bridgeError).not.toBeInstanceOf(WasmEngineError)
      expect(pending.size).toBe(0)
    }
  })

  it('preserves valid bridge write successes and legacy and guarded errors', async () => {
    const { makeBridgeError } = await import('./wasmEngine')
    const { createParameterWriteService } = await import('../modeling/parameterWriteService')
    const input = { owner: 'geometry' as const, ownerId: 'geom', parameterId: 'parm', value: 1.5 }
    const identity = { sessionId: 'session', modelEpoch: '42' }
    const execute = (response: Record<string, unknown>) => {
      const pending = new Map<number, BridgePending>()
      const service = createParameterWriteService({ set: () => {
        const result = request(pending, 1)
        settleBridgeResult(pending, { id: 1, ...response }, () => null, makeBridgeError)
        return result as Promise<{ actual: number }>
      } })
      return service.set(input, identity)
    }
    await expect(execute({ ok: true, value: { actual: 1.5 } })).resolves.toEqual({ actual: 1.5 })
    await expect(execute({ ok: false, error: 'STALE_MODEL', code: 'STALE_MODEL', outcome: 'not_written', actual: null })).rejects.toMatchObject({ code: 'STALE_MODEL' })
    await expect(execute({ ok: false, error: 'ordinary', outcome: 'not_written' })).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    await expect(execute({ ok: false, error: 'legacy error' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })

  it('best-effort drains malformed binary results without changing their errors or stopping the batch', async () => {
    const pending = new Map<number, BridgePending>()
    const first = request(pending, 1)
    const second = request(pending, 2)
    const next = request(pending, 3)
    const take = vi.fn((id: number) => {
      if (id === 2) throw new Error('private binary failure')
      return new Uint8Array([7])
    })
    const mirror = vi.fn()
    drainBatch({ proc: [], out: [
      { t: 'result', id: 1, ok: 'true', bin: true },
      { t: 'result', id: 2, ok: false, error: null, bin: true },
      { t: 'result', id: 3, ok: true, value: 42 },
    ], mirror: [{ t: 'diff' }] }, () => {}, (result: Record<string, unknown>) => {
      settleBridgeResult(pending, result, take, () => new Error('trusted engine error'))
    }, mirror)
    await expect(first).rejects.toEqual(new Error('Invalid engine result response'))
    await expect(second).rejects.toEqual(new Error('Invalid engine result response'))
    await expect(next).resolves.toBe(42)
    expect(take.mock.calls).toEqual([[1], [2]])
    expect(pending.size).toBe(0)
    expect(mirror).toHaveBeenCalledExactlyOnceWith([{ t: 'diff' }])
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
    settleBridgeResult(pending, { id: 1, ok: false, error: 'engine error', bin: true }, take, () => engineError)
    settleBridgeResult(pending, { id: 2, ok: true, bin: true }, take, () => new Error())
    await expect(failed).rejects.toBe(engineError)
    await expect(empty).resolves.toEqual(new ArrayBuffer(0))
    expect(take.mock.calls).toEqual([[2]])
    expect(pending.size).toBe(0)
  })
})
