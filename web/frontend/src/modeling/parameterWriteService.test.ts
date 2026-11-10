import { describe, expect, it, vi } from 'vitest'
import { WasmEngineError } from '../api/wasmEngine'
import { createParameterWriteService } from './parameterWriteService'

vi.mock('../api/wasmEngine', () => ({
  WasmEngineError: class WasmEngineError extends Error {
    status: number
    outcome?: 'not_written' | 'different' | 'unknown'
    actual?: number | null
    constructor(status: number, message: string, outcome?: 'not_written' | 'different' | 'unknown', actual?: number | null) {
      super(message); this.status = status; this.outcome = outcome; this.actual = actual
    }
  },
}))

const input = { owner: 'geometry' as const, ownerId: 'geom', parameterId: 'parm', value: 1.5 }
function fixture() {
  const adapter = { set: vi.fn(async (_owner: 'geometry' | 'crossSection', _ownerId: string, _parameterId: string, value: number) => ({ actual: value })) }
  return { adapter, service: createParameterWriteService(adapter) }
}

describe('single parameter write service', () => {
  it('writes exactly one scoped parameter and returns engine readback', async () => {
    const { adapter, service } = fixture()
    await expect(service.set(input)).resolves.toEqual({ actual: 1.5 })
    await expect(service.set({ ...input, owner: 'crossSection', value: 0 })).resolves.toEqual({ actual: 0 })
    expect(adapter.set.mock.calls).toEqual([['geometry', 'geom', 'parm', 1.5], ['crossSection', 'geom', 'parm', 0]])
  })
  it('rejects malformed IDs and non-finite or non-numeric values before writing', async () => {
    const { adapter, service } = fixture()
    for (const patch of [{ owner: 'vehicle' }, { ownerId: '' }, { ownerId: 'a b' }, { ownerId: '\u0000' }, { ownerId: '\ud800' }, { parameterId: null }, { parameterId: ' ' }, { value: NaN }, { value: Infinity }, { value: -Infinity }, { value: '1' }]) {
      await expect(service.set({ ...input, ...patch } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(service.set(null as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(adapter.set).not.toHaveBeenCalled()
  })
  it('preserves known outcome and finite actual without leaking engine text', async () => {
    for (const [outcome, code] of [['not_written', 'ENGINE_ERROR'], ['different', 'OUTCOME_UNKNOWN'], ['unknown', 'OUTCOME_UNKNOWN']] as const) {
      const { adapter, service } = fixture()
      adapter.set.mockRejectedValue(new WasmEngineError(400, 'private engine detail', outcome, 2))
      const error = await service.set(input).catch(e => e)
      expect(error).toMatchObject({ code, details: { outcome, actual: 2 } })
      expect(JSON.stringify(error)).not.toContain('private')
      expect(adapter.set).toHaveBeenCalledTimes(1)
    }
  })
  it('sanitizes unknown, malformed and non-engine errors without retrying', async () => {
    for (const thrown of [new Error('secret'), new WasmEngineError(500, 'secret'), new WasmEngineError(500, 'secret', 'unknown', NaN)]) {
      const { adapter, service } = fixture()
      adapter.set.mockRejectedValue(thrown)
      const error = await service.set(input).catch(e => e)
      expect(error.code).toBe('OUTCOME_UNKNOWN')
      expect(JSON.stringify(error)).not.toContain('secret')
      expect(adapter.set).toHaveBeenCalledTimes(1)
    }
  })
  it('does not report success for malformed or differing readback', async () => {
    for (const result of [null, {}, { actual: NaN }, { actual: Infinity }, { actual: 2 }]) {
      const { adapter, service } = fixture()
      adapter.set.mockResolvedValue(result as never)
      await expect(service.set(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      expect(adapter.set).toHaveBeenCalledTimes(1)
    }
  })
})
