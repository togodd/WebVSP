import { api } from '../api/client'
import { createReadService } from './readService'
import { createParameterService } from './parameterService'
import type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'
import { getEngineSessionId, wasmRequest } from '../api/wasmEngine'
import { createWriteService } from './writeService'

export * from './contracts'
export type { ModelingReadAdapter } from './readService'
export { createReadService } from './readService'
export { createParameterService } from './parameterService'
export type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'

/** Create a handle for this browser engine. Closing a handle does not stop the engine. */
export function createBrowserModelingService() {
  const read = createReadService({ model: api.model, bbox: api.bbox }, getEngineSessionId())
  const path = (owner: 'geometry' | 'crossSection', ownerId: string) => `/${owner === 'geometry' ? 'geoms' : 'xsecs'}/${encodeURIComponent(ownerId)}/parms`
  const adapter: ParameterReadAdapter = {
    surfaces: async (geometryId) => await wasmRequest('GET', `/geoms/${encodeURIComponent(geometryId)}/xsecs`) as CrossSectionSurface[],
    list: async (owner, ownerId) => await wasmRequest('GET', path(owner, ownerId)) as string[],
    get: async (owner, ownerId, parameterId) => await wasmRequest('GET', `${path(owner, ownerId)}/${encodeURIComponent(parameterId)}`) as EngineParameter,
  }
  let closed = false
  const ensureOpen = () => { if (closed) throw new Error('Session closed') }
  const write = createWriteService({
    model: () => { ensureOpen(); return api.model() },
    geomTypes: () => { ensureOpen(); return api.geomTypes() },
    addGeom: async (type, parentId) => { ensureOpen(); return await wasmRequest('POST', '/geoms', { type, parent: parentId }) as { id: string } },
    geomOrigin: (id) => { ensureOpen(); return api.geomOrigin(id) },
    moveGeoms: async (ids, delta) => { ensureOpen(); return await api.moveGeoms(ids, delta) as { ok: boolean } },
  })
  return { ...read, close: () => { closed = true; read.close() }, capabilities: () => {
    const result = read.capabilities()
    return { ...result, features: result.features.map((c) => ['parameter.read', 'geometry.create', 'geometry.move'].includes(c.name) ? { name: c.name, status: 'supported' as const } : c) }
  }, parameter: createParameterService(adapter, () => closed), write }
}
