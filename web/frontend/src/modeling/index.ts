import { api } from '../api/client'
import { createReadService } from './readService'
import { createParameterService } from './parameterService'
import type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'
import { getEngineSessionId, wasmRequest } from '../api/wasmEngine'
import { createWriteService } from './writeService'
import { createParameterWriteService } from './parameterWriteService'
import { createWingService } from './wingService'
import { createFuselageService } from './fuselageService'

export * from './contracts'
export type { ModelingReadAdapter } from './readService'
export { createReadService } from './readService'
export { createParameterService } from './parameterService'
export { createParameterWriteService } from './parameterWriteService'
export type { ParameterOwner, ParameterWriteAdapter, ParameterWriteInput } from './parameterWriteService'
export type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'

/** Create a handle for this browser engine. Closing a handle does not stop the engine. */
export function createBrowserModelingService() {
  const read = createReadService({ model: api.model, bbox: api.bbox }, getEngineSessionId())
  const path = (owner: 'geometry' | 'crossSection', ownerId: string) => `/${owner === 'geometry' ? 'geoms' : 'xsecs'}/${encodeURIComponent(ownerId)}/parms`
  const adapter: ParameterReadAdapter = {
    surfaces: async (geometryId) => await wasmRequest('GET', `/geoms/${encodeURIComponent(geometryId)}/xsecs`) as CrossSectionSurface[],
    fuselageLength: async (geometryId) => await wasmRequest('GET', `/geoms/${encodeURIComponent(geometryId)}/fuselage-length`) as EngineParameter,
    list: async (owner, ownerId) => await wasmRequest('GET', path(owner, ownerId)) as string[],
    get: async (owner, ownerId, parameterId) => await wasmRequest('GET', `${path(owner, ownerId)}/${encodeURIComponent(parameterId)}`) as EngineParameter,
  }
  const controller = new AbortController()
  const write = createWriteService({
    model: () => api.model(),
    geomTypes: () => api.geomTypes(),
    addGeom: async (type, parentId) => await wasmRequest('POST', '/geoms', { type, parent: parentId }) as { id: string },
    geomOrigin: (id) => api.geomOrigin(id),
    moveGeoms: async (ids, delta) => await api.moveGeoms(ids, delta) as { ok: boolean },
  }, controller.signal)
  const parameter = {
    ...createParameterService(adapter, controller.signal),
    ...createParameterWriteService({
      set: async (owner, ownerId, parameterId, value) => await wasmRequest('PUT', `${path(owner, ownerId)}/${encodeURIComponent(parameterId)}`, { value }) as { actual: number },
    }, controller.signal),
  }
  return { ...read, close: () => { controller.abort(); read.close() }, capabilities: () => {
    const result = read.capabilities()
    return { ...result, features: result.features.map((c) => ['parameter.read', 'parameter.write', 'geometry.create', 'geometry.move', 'wing.read', 'fuselage.read'].includes(c.name) ? { name: c.name, status: 'supported' as const } : c) }
  }, parameter, wing: createWingService({ geometry: read.geometry, parameters: parameter }), fuselage: createFuselageService(read.geometry, parameter), write }
}
