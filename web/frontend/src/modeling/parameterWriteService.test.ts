import { describe, expect, it, vi } from 'vitest'
import { WasmEngineError } from '../api/wasmEngine'
import { createParameterWriteService } from './parameterWriteService'

vi.mock('../api/wasmEngine', () => ({
  WasmEngineError: class WasmEngineError extends Error {
    status: number
    outcome?: 'not_written' | 'different' | 'unknown'
    actual?: number | null
    code?: string
    constructor(status: number, message: string, outcome?: 'not_written' | 'different' | 'unknown', actual?: number | null, code?: string) {
      super(message); this.status = status; this.outcome = outcome; this.actual = actual; this.code = code
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
  it('forwards identity and preserves only a confirmed stale not-written outcome', async () => {
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    const { adapter, service } = fixture()
    await service.set(input, identity)
    expect(adapter.set).toHaveBeenCalledWith('geometry', 'geom', 'parm', 1.5, identity)
    expect((adapter.set.mock.calls[0] as unknown as [string, string, string, number, typeof identity])[4]).not.toBe(identity)
    adapter.set.mockRejectedValue(new WasmEngineError(409, 'secret', 'not_written', null, 'STALE_MODEL'))
    await expect(service.set(input, identity)).rejects.toMatchObject({ code: 'STALE_MODEL', details: { outcome: 'not_written' } })
    await expect(service.set(input)).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    adapter.set.mockRejectedValue(new WasmEngineError(409, 'secret', 'unknown', null, 'STALE_MODEL'))
    await expect(service.set(input, identity)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    adapter.set.mockRejectedValue(new Error('secret'))
    await expect(service.set(input, identity)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
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
  it('rejects before dispatch after close, including invalid input', async () => {
    const controller = new AbortController()
    const { adapter } = fixture()
    const service = createParameterWriteService(adapter, controller.signal)
    controller.abort()
    await expect(service.set(input)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(service.set(null as never)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(adapter.set).not.toHaveBeenCalled()
  })
  it.each([false, true])('does not dispatch if the adapter set getter closes (throws: %s)', async (throws) => {
    const controller = new AbortController()
    const write = vi.fn(async () => ({ actual: input.value }))
    let reads = 0
    const adapter = { get set() {
      reads++
      controller.abort()
      if (throws) throw new Error('private')
      return write
    } }
    const service = createParameterWriteService(adapter, controller.signal)
    await expect(service.set(input)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(reads).toBe(1)
    expect(write).not.toHaveBeenCalled()
  })
  it('preserves the adapter receiver and reports unknown once the write starts', async () => {
    const controller = new AbortController()
    const adapter = { set: vi.fn(function (this: unknown) {
      expect(this).toBe(adapter)
      controller.abort()
      return Promise.resolve({ actual: input.value })
    }) }
    await expect(createParameterWriteService(adapter, controller.signal).set(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })
  it('sanitizes an adapter getter failure without close', async () => {
    const adapter = { get set(): never { throw new Error('private') } }
    await expect(createParameterWriteService(adapter).set(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it.each(['resolve', 'reject'] as const)('reports unknown on close after dispatch and consumes late %s', async (settle) => {
    const controller = new AbortController()
    let resolve!: (value: { actual: number }) => void
    let reject!: (reason: Error) => void
    const adapter = { set: vi.fn(() => new Promise<{ actual: number }>((yes, no) => { resolve = yes; reject = no })) }
    const service = createParameterWriteService(adapter, controller.signal)
    const pending = service.set(input)
    expect(adapter.set).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    if (settle === 'resolve') resolve({ actual: input.value })
    else reject(new Error('late engine failure'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })
  it('reports unknown if close follows a settled engine response before delivery', async () => {
    const controller = new AbortController()
    const adapter = { set: vi.fn(async () => ({ actual: input.value })) }
    const service = createParameterWriteService(adapter, controller.signal)
    const pending = service.set(input)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('snapshots each input field once and maps getter failures to invalid argument', async () => {
    const { adapter, service } = fixture()
    const counts: Record<string, number> = {}
    const malicious = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, {
      enumerable: true, get() { counts[key] = (counts[key] ?? 0) + 1; return counts[key] === 1 ? value : undefined },
    }]))
    await expect(service.set(Object.defineProperties({}, malicious) as typeof input)).resolves.toEqual({ actual: 1.5 })
    expect(counts).toEqual({ owner: 1, ownerId: 1, parameterId: 1, value: 1 })
    for (const field of Object.keys(input)) {
      const bad = { ...input, get [field]() { throw new Error('private') } }
      await expect(service.set(bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })
  it('prioritizes close if an input or identity getter closes and throws', async () => {
    for (const which of ['input', 'identity']) {
      const controller = new AbortController()
      const { adapter } = fixture()
      const service = createParameterWriteService(adapter, controller.signal)
      const fail = () => { controller.abort(); throw new Error('private') }
      const badInput = which === 'input' ? { ...input, get ownerId(): string { return fail() } } : input
      const identity = which === 'identity' ? { get sessionId(): string { return fail() }, modelEpoch: 'epoch' } : undefined
      await expect(service.set(badInput, identity)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(adapter.set).not.toHaveBeenCalled()
    }
  })
  it('validates and snapshots identity without exposing the caller object', async () => {
    const counts = { sessionId: 0, modelEpoch: 0 }
    const identity = {
      get sessionId() { counts.sessionId++; return counts.sessionId === 1 ? ' session ' : '' },
      get modelEpoch() { counts.modelEpoch++; return counts.modelEpoch === 1 ? ' epoch ' : '' },
    }
    const adapter = { set: vi.fn(async (_a: string, _b: string, _c: string, value: number, copy?: { sessionId: string; modelEpoch: string }) => {
      expect(copy).toEqual({ sessionId: ' session ', modelEpoch: ' epoch ' })
      if (copy) copy.sessionId = 'modified'
      return { actual: value }
    }) }
    const service = createParameterWriteService(adapter)
    await service.set(input, identity)
    expect(counts).toEqual({ sessionId: 1, modelEpoch: 1 })
    expect(adapter.set.mock.calls[0][4]).not.toBe(identity)
    for (const bad of [null, {}, { sessionId: '', modelEpoch: 'e' }, { sessionId: 's', modelEpoch: 0 }, { get sessionId() { throw Error('secret') }, modelEpoch: 'e' }]) {
      await expect(service.set(input, bad as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })
  it('reads result actual once and sanitizes throwing readbacks', async () => {
    const { adapter, service } = fixture()
    let reads = 0
    adapter.set.mockResolvedValue({ get actual() { return ++reads === 1 ? 1.5 : 2 } })
    await expect(service.set(input)).resolves.toEqual({ actual: 1.5 })
    expect(reads).toBe(1)
    adapter.set.mockResolvedValue({ get actual(): number { throw new Error('private') } })
    await expect(service.set(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    const error = new WasmEngineError(400, 'private', 'not_written')
    Object.defineProperty(error, 'actual', { get() { throw new Error('private') } })
    adapter.set.mockRejectedValue(error)
    await expect(service.set(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
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
