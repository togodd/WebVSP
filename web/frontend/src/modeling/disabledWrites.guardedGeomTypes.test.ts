import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  api: { model: vi.fn(), bbox: vi.fn(), addGeom: vi.fn(), moveGeoms: vi.fn(), setParm: vi.fn() },
}))
vi.mock('../api/wasmEngine', async (importOriginal) => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  const actual = await importOriginal<typeof import('../api/wasmEngine')>()
  vi.unstubAllGlobals()
  return {
    ...actual,
    getEngineSessionId: () => 'tab',
    callGuarded: vi.fn(async () => ['Wing']),
    discoverModel: vi.fn(),
    discoverModelingProtocol: vi.fn(async () => ({
      protocol: 'webvsp-modeling', version: 1, operations: ['model', 'guardedEpochV1', 'geomTypes'],
    })),
  }
})

import { api } from '../api/client'
import { callGuarded, discoverModel, discoverModelingProtocol, GUARDED_OPS } from '../api/wasmEngine'
import { createBrowserModelingService, ModelingError } from './index'

const identity = { sessionId: 'tab', modelEpoch: '42' }
const cases = [
  {
    name: 'parameter.write', message: 'Parameter writes are disabled pending reentrancy safety review',
    invoke: (service: ReturnType<typeof createBrowserModelingService>) => service.parameter.set({ owner: 'geometry', ownerId: 'geom', parameterId: 'parm', value: 5 }, identity),
  },
  {
    name: 'geometry.create', message: 'Geometry creation is disabled pending reentrancy safety review',
    invoke: (service: ReturnType<typeof createBrowserModelingService>) => service.write.create({ type: 'Wing', parentId: null }, identity),
  },
  {
    name: 'geometry.move', message: 'Geometry movement is disabled pending reentrancy safety review',
    invoke: (service: ReturnType<typeof createBrowserModelingService>) => service.write.move({ geometryId: 'geom', frame: 'world', units: 'model-native', delta: [1, 2, 3] }, identity),
  },
] as const

describe('browser facade writes remain disabled with guarded geomTypes', () => {
  it.each(cases)('$name stays unsupported and dispatches nothing before and after protocol discovery', async ({ name, message, invoke }) => {
    expect(GUARDED_OPS).toContain('geomTypes')
    vi.clearAllMocks()
    const service = createBrowserModelingService()
    try {
      const expectedCapability = { name, status: 'unsupported', reason: 'Disabled pending reentrancy safety review' }
      for (const phase of ['before', 'after'] as const) {
        if (phase === 'after') {
          await service.protocol()
          expect(discoverModelingProtocol).toHaveBeenCalledOnce()
        }
        expect(service.capabilities().features.find(feature => feature.name === name)).toEqual(expectedCapability)
        const error = await invoke(service).then(() => null, (reason: unknown) => reason)
        expect(error).toBeInstanceOf(ModelingError)
        expect((error as ModelingError).toJSON()).toEqual({ code: 'UNSUPPORTED_OPERATION', message })
        expect(callGuarded).not.toHaveBeenCalled()
        expect(discoverModel).not.toHaveBeenCalled()
        for (const request of Object.values(api)) expect(request).not.toHaveBeenCalled()
      }
    } finally {
      service.close()
    }
  })
})
