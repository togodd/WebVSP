import { describe, expect, it, vi } from 'vitest'
import { createParameterService } from './parameterService'

describe('linkable parameter reads', () => {
  it('routes geometry and cross section owners distinctly', async () => {
    const adapter = { surfaces: vi.fn(async () => [{ id: 'surf', xsecs: ['xs'] }]), list: vi.fn(async () => ['parm']), get: vi.fn(async () => ({ id: 'parm', value: 1, type: 0, name: 'Length', group: 'Design', container: 'geom', lowerLimit: 0, upperLimit: 10, active: true })) }
    const service = createParameterService(adapter)
    expect(await service.listSurfaces('geom')).toEqual([{ id: 'surf', xsecs: ['xs'] }])
    await service.listGeometryParameterIds('geom'); await service.listCrossSectionParameterIds('xs')
    await service.getGeometryParameter('geom', 'parm'); await service.getCrossSectionParameter('xs', 'parm')
    expect(adapter.list.mock.calls).toEqual([['geometry', 'geom'], ['crossSection', 'xs']])
    expect(adapter.get.mock.calls).toEqual([['geometry', 'geom', 'parm'], ['crossSection', 'xs', 'parm']])
  })
  it('rejects invalid inputs and sanitizes backend errors', async () => {
    const service = createParameterService({ surfaces: async () => { throw new Error('secret') }, list: async () => [], get: async () => { throw new Error('secret') } })
    expect(() => service.listSurfaces('')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(() => service.getGeometryParameter('geom', '')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    await expect(service.listSurfaces('geom')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
  })
})
