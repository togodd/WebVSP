import { describe, expect, it, vi } from 'vitest'
import { createParameterService } from './parameterService'
import { WasmEngineError } from '../api/wasmEngine'

vi.mock('../api/wasmEngine', () => ({
  WasmEngineError: class WasmEngineError extends Error {
    status: number
    outcome?: string
    actual?: number | null
    code?: string
    constructor(status: number, message: string, outcome?: string, actual?: number | null, code?: string) {
      super(message); this.status = status; this.outcome = outcome; this.actual = actual; this.code = code
    }
  },
}))

describe('linkable parameter reads', () => {
  it('routes geometry and cross section owners distinctly', async () => {
    const adapter = { fuselageLength: vi.fn(async () => ({ id: 'parm', value: 1, type: 0, name: 'Length', group: 'Design', container: 'geom', lowerLimit: 0, upperLimit: 10, active: true })), surfaces: vi.fn(async () => [{ id: 'surf', xsecs: ['xs'] }]), list: vi.fn(async () => ['parm']), get: vi.fn(async () => ({ id: 'parm', value: 1, type: 0, name: 'Length', group: 'Design', container: 'geom', lowerLimit: 0, upperLimit: 10, active: true })) }
    const service = createParameterService(adapter)
    expect(await service.listSurfaces('geom')).toEqual([{ id: 'surf', xsecs: ['xs'] }])
    expect(await service.getFuselageLength('geom')).toMatchObject({ id: 'parm', name: 'Length', group: 'Design', container: 'geom' })
    expect(adapter.fuselageLength).toHaveBeenCalledWith('geom')
    await service.listGeometryParameterIds('geom'); await service.listCrossSectionParameterIds('xs')
    await service.getGeometryParameter('geom', 'parm'); await service.getCrossSectionParameter('xs', 'parm')
    expect(adapter.list.mock.calls).toEqual([['geometry', 'geom'], ['crossSection', 'xs']])
    expect(adapter.get.mock.calls).toEqual([['geometry', 'geom', 'parm'], ['crossSection', 'xs', 'parm']])
  })
  it('forwards the exact identity to every read and maps only engine stale errors', async () => {
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    const stale = new WasmEngineError(409, 'secret', undefined, undefined, 'STALE_MODEL')
    const adapter = { surfaces: vi.fn(async () => { throw stale }), fuselageLength: vi.fn(async () => { throw stale }), list: vi.fn(async () => { throw stale }), get: vi.fn(async () => { throw stale }) }
    const service = createParameterService(adapter)
    const calls = [service.listSurfaces('g', identity), service.getFuselageLength('g', identity), service.listGeometryParameterIds('g', identity), service.listCrossSectionParameterIds('x', identity), service.getGeometryParameter('g', 'p', identity), service.getCrossSectionParameter('x', 'p', identity)]
    await Promise.all(calls.map(p => expect(p).rejects.toMatchObject({ code: 'STALE_MODEL' })))
    expect(adapter.surfaces).toHaveBeenCalledWith('g', identity)
    expect(adapter.fuselageLength).toHaveBeenCalledWith('g', identity)
    expect(adapter.list.mock.calls).toEqual([['geometry', 'g', identity], ['crossSection', 'x', identity]])
    expect(adapter.get.mock.calls).toEqual([['geometry', 'g', 'p', identity], ['crossSection', 'x', 'p', identity]])
    expect((adapter.surfaces.mock.calls[0] as unknown as [string, typeof identity])[1]).toBe(identity)
    await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    adapter.surfaces.mockRejectedValue(new Error('secret'))
    await expect(service.listSurfaces('g', identity)).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
  })
  it('races every pending parameter read with close and consumes late rejections', async () => {
    const controller = new AbortController()
    const rejects: ((e: Error) => void)[] = []
    const pendingRequest = () => new Promise<never>((_, reject) => { rejects.push(reject) })
    const adapter = { surfaces: vi.fn(pendingRequest), fuselageLength: vi.fn(pendingRequest), list: vi.fn(pendingRequest), get: vi.fn(pendingRequest) }
    const service = createParameterService(adapter, controller.signal)
    const pending = [service.getFuselageLength('g'), service.listSurfaces('g'), service.listGeometryParameterIds('g'), service.listCrossSectionParameterIds('x'), service.getGeometryParameter('g', 'p'), service.getCrossSectionParameter('x', 'p')]
    controller.abort()
    await Promise.all(pending.map((p) => expect(p).rejects.toMatchObject({ code: 'SESSION_CLOSED' })))
    rejects.forEach((reject) => reject(new Error('late')))
    expect(() => service.listSurfaces('')).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
    expect(adapter.surfaces).toHaveBeenCalledTimes(1)
  })
  it('validates all parameter fields, permits null numbers and finite boundaries', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    let response: unknown = parameter
    const service = createParameterService({ surfaces: async () => [], list: async () => [], get: async () => response as typeof parameter, fuselageLength: async () => response as typeof parameter })
    for (const field of ['value', 'lowerLimit', 'upperLimit'] as const) {
      for (const valid of [null, 0, -1, Number.MAX_VALUE]) {
        response = { ...parameter, [field]: valid }
        await expect(service.getGeometryParameter('g', 'p')).resolves.toEqual(response)
      }
      for (const invalid of [undefined, NaN, Infinity, -Infinity, '1', false]) {
        response = { ...parameter, [field]: invalid }
        await expect(service.getGeometryParameter('g', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      }
    }
    const invalidFields: Record<string, unknown[]> = {
      id: ['', ' ', null, 1], type: [null, '0', 0.5, NaN, Infinity],
      name: [null, 1], group: [null, 1], container: [null, 1], active: [null, 0, 'true'],
    }
    for (const [field, values] of Object.entries(invalidFields)) for (const value of values) {
      response = { ...parameter, [field]: value }
      await expect(service.getCrossSectionParameter('x', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    for (const invalid of [null, [], 'parameter', {}]) {
      response = invalid
      await expect(service.getGeometryParameter('g', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    response = { ...parameter, type: -1, name: '', group: '', container: '', active: false }
    await expect(service.getGeometryParameter('g', 'p')).resolves.toEqual(response)
    response = { ...parameter, id: 'other' }
    await expect(service.getGeometryParameter('g', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    await expect(service.getCrossSectionParameter('x', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    response = parameter
    await expect(service.getFuselageLength('g')).resolves.toEqual(parameter)
    for (const [field, value] of [['name', 'length'], ['group', 'Other'], ['container', 'other'], ['id', '']] as const) {
      response = { ...parameter, [field]: value }
      await expect(service.getFuselageLength('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('validates nested surfaces and both parameter ID lists', async () => {
    let response: unknown = []
    const service = createParameterService({ surfaces: async () => response as never, list: async () => response as never, get: async () => { throw new Error() }, fuselageLength: async () => { throw new Error() } })
    for (const valid of [[], [{ id: 's', xsecs: [] }], [{ id: 's', xsecs: ['x', 'y'] }]]) {
      response = valid; await expect(service.listSurfaces('g')).resolves.toEqual(valid)
    }
    for (const invalid of [null, {}, [null], ['s'], [{}], [{ id: '', xsecs: [] }], [{ id: 's', xsecs: null }], [{ id: 's', xsecs: ['x', ' '] }], [{ id: 's', xsecs: [1] }]]) {
      response = invalid; await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    for (const valid of [[], ['a', 'b']]) {
      response = valid
      await expect(service.listGeometryParameterIds('g')).resolves.toEqual(valid)
      await expect(service.listCrossSectionParameterIds('x')).resolves.toEqual(valid)
    }
    for (const invalid of [null, {}, [''], [' '], [1], ['a', null]]) {
      response = invalid
      await expect(service.listGeometryParameterIds('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      await expect(service.listCrossSectionParameterIds('x')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('rejects invalid inputs and sanitizes backend errors', async () => {
    const service = createParameterService({ fuselageLength: async () => { throw new Error('secret') }, surfaces: async () => { throw new Error('secret') }, list: async () => [], get: async () => { throw new Error('secret') } })
    expect(() => service.listSurfaces('')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(() => service.getFuselageLength(' ')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    await expect(service.getFuselageLength('geom')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
    expect(() => service.getGeometryParameter('geom', '')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    await expect(service.listSurfaces('geom')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
  })
})
