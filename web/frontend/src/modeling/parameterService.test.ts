import { describe, expect, it, vi } from 'vitest'
import { createParameterService } from './parameterService'

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
  it('rejects invalid inputs and sanitizes backend errors', async () => {
    const service = createParameterService({ fuselageLength: async () => { throw new Error('secret') }, surfaces: async () => { throw new Error('secret') }, list: async () => [], get: async () => { throw new Error('secret') } })
    expect(() => service.listSurfaces('')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(() => service.getFuselageLength(' ')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    await expect(service.getFuselageLength('geom')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
    expect(() => service.getGeometryParameter('geom', '')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    await expect(service.listSurfaces('geom')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
  })
})
