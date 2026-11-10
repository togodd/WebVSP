import { api } from '../api/client'
import { createReadService } from './readService'
import { createParameterService } from './parameterService'
import type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'
import { wasmRequest } from '../api/wasmEngine'

export * from './contracts'
export type { ModelingReadAdapter } from './readService'
export { createReadService } from './readService'
export { createParameterService } from './parameterService'
export type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'

// One browser module owns one engine; multiple service handles share its session identity.
const sessionId = crypto.randomUUID()

/** Create a handle for this browser engine. Closing a handle does not stop the engine. */
export function createBrowserModelingService() {
  const read = createReadService({ model: api.model, bbox: api.bbox }, sessionId)
  const path = (owner: 'geometry' | 'crossSection', ownerId: string) => `/${owner === 'geometry' ? 'geoms' : 'xsecs'}/${encodeURIComponent(ownerId)}/parms`
  const adapter: ParameterReadAdapter = {
    surfaces: async (geometryId) => await wasmRequest('GET', `/geoms/${encodeURIComponent(geometryId)}/xsecs`) as CrossSectionSurface[],
    list: async (owner, ownerId) => await wasmRequest('GET', path(owner, ownerId)) as string[],
    get: async (owner, ownerId, parameterId) => await wasmRequest('GET', `${path(owner, ownerId)}/${encodeURIComponent(parameterId)}`) as EngineParameter,
  }
  let closed = false
  return { ...read, close: () => { closed = true; read.close() }, capabilities: () => {
    const result = read.capabilities()
    return { ...result, features: result.features.map((c) => c.name === 'parameter.read' ? { name: c.name, status: 'supported' as const } : c) }
  }, parameter: createParameterService(adapter, () => closed) }
}
