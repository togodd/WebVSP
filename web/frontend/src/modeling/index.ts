import { api } from '../api/client'
import type { ModelTree } from '../api/types'
import { callGuarded, getEngineSessionId, WasmEngineError } from '../api/wasmEngine'
import { ModelingError, type ModelIdentity } from './contracts'
import { createReadService } from './readService'
import { createParameterService } from './parameterService'
import type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'
import type { CreateGeometryInput, MoveGeometryInput } from './writeService'
import type { ParameterWriteInput } from './parameterWriteService'
import { createWingService } from './wingService'
import { createFuselageService } from './fuselageService'

export * from './contracts'
export type { ModelingReadAdapter } from './readService'
export { createReadService } from './readService'
export { createParameterService } from './parameterService'
export { createParameterWriteService } from './parameterWriteService'
export type { ParameterOwner, ParameterWriteAdapter, ParameterWriteInput } from './parameterWriteService'
export type { CrossSectionSurface, EngineParameter, ParameterReadAdapter } from './parameterService'

/** Identity guarding detects replacement at each engine job, not concurrent edits or reentrancy. */
export function createBrowserModelingService() {
  const sessionId = getEngineSessionId()
  const controller = new AbortController()
  const read = createReadService({ model: api.model, bbox: api.bbox }, sessionId)
  function identity(value: ModelIdentity): ModelIdentity {
    if (controller.signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
    if (!value) throw new ModelingError('INVALID_ARGUMENT', 'A valid model identity is required')
    let tokenSessionId: unknown, modelEpoch: unknown
    try { ({ sessionId: tokenSessionId, modelEpoch } = value) } catch {
      throw new ModelingError('INVALID_ARGUMENT', 'A valid model identity is required')
    }
    if (typeof tokenSessionId !== 'string' || !tokenSessionId.trim() || typeof modelEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(modelEpoch) || modelEpoch.length > 20 || (modelEpoch.length === 20 && modelEpoch > '18446744073709551615')) throw new ModelingError('INVALID_ARGUMENT', 'A valid model identity is required')
    if (tokenSessionId !== sessionId) throw new ModelingError('STALE_MODEL', 'Model identity does not match this session')
    return Object.freeze({ sessionId: tokenSessionId, modelEpoch })
  }
  function scoped(token: ModelIdentity) {
    const call = <T>(op: Parameters<typeof callGuarded>[0], a = '', b = '', value = 0) => callGuarded<T>(op, a, b, value, token.modelEpoch)
    const model = async () => {
      const tree = await call<ModelTree>('model')
      // Match the public model route's file name presentation.
      const name = tree.fileName
      return { ...tree, fileName: name === 'Unnamed.vsp3' ? '' : name.startsWith('/home/web_user/') ? name.slice('/home/web_user/'.length) : name.replace(/^\//, '') }
    }
    const readScoped = createReadService({
      model: async () => {
        try { return await model() } catch (error) {
          if (error instanceof WasmEngineError && error.code === 'STALE_MODEL') throw new ModelingError('STALE_MODEL', 'The model identity is stale')
          throw error
        }
      },
      bbox: async () => {
        try { return await call<Awaited<ReturnType<typeof api.bbox>>>('bbox') } catch (error) {
          if (error instanceof WasmEngineError && error.code === 'STALE_MODEL') throw new ModelingError('STALE_MODEL', 'The model identity is stale')
          throw error
        }
      },
    }, sessionId)
    // Also close scoped reads when the parent handle closes.
    const abort = () => readScoped.close()
    controller.signal.addEventListener('abort', abort, { once: true })
    const dispose = () => { controller.signal.removeEventListener('abort', abort); readScoped.close() }
    const adapter: ParameterReadAdapter = {
      surfaces: (id) => call<CrossSectionSurface[]>('geomXSecs', id),
      fuselageLength: (id) => call<EngineParameter>('fuselageLength', id),
      list: (owner, id) => call<string[]>(owner === 'geometry' ? 'geomParmIDs' : 'xsecParmIDs', id),
      get: (owner, id, parm) => call<EngineParameter>(owner === 'geometry' ? 'geomParm' : 'xsecParm', id, parm),
    }
    const parameter = createParameterService(adapter, controller.signal)
    return { read: readScoped, parameter, wing: createWingService({ geometry: readScoped.geometry, parameters: parameter }), fuselage: createFuselageService(readScoped.geometry, parameter), dispose }
  }
  async function run<T>(token: ModelIdentity, fn: (scope: ReturnType<typeof scoped>, token: ModelIdentity) => Promise<T>): Promise<T> {
    const t = identity(token), scope = scoped(t)
    try { return await fn(scope, t) } finally { scope.dispose() }
  }
  return {
    close() { controller.abort(); read.close() },
    capabilities() {
      const result = read.capabilities()
      return { ...result, features: result.features.map((c) => ['parameter.read', 'wing.read', 'fuselage.read'].includes(c.name) ? { name: c.name, status: 'supported' as const } : ['parameter.write', 'geometry.create', 'geometry.move'].includes(c.name) ? { name: c.name, status: 'unsupported' as const, reason: 'Disabled pending reentrancy safety review' } : c) }
    },
    model: {
      getInfo: (token?: ModelIdentity) => token === undefined ? read.model.getInfo() : run(token, (s, t) => s.read.model.getInfo(t)),
      getSelection: (token: ModelIdentity) => run(token, (s) => s.read.model.getSelection()),
      getVisibleSurfaceBounds: (token: ModelIdentity) => run(token, (s) => s.read.model.getVisibleSurfaceBounds()),
    },
    geometry: {
      list: (token: ModelIdentity) => run(token, (s) => s.read.geometry.list()),
      get: (id: string, token: ModelIdentity) => run(token, (s, t) => s.read.geometry.get(id, t)),
    },
    parameter: {
      listSurfaces: (id: string, token: ModelIdentity) => run(token, (s, t) => s.parameter.listSurfaces(id, t)),
      getFuselageLength: (id: string, token: ModelIdentity) => run(token, (s, t) => s.parameter.getFuselageLength(id, t)),
      listGeometryParameterIds: (id: string, token: ModelIdentity) => run(token, (s, t) => s.parameter.listGeometryParameterIds(id, t)),
      listCrossSectionParameterIds: (id: string, token: ModelIdentity) => run(token, (s, t) => s.parameter.listCrossSectionParameterIds(id, t)),
      getGeometryParameter: (id: string, parm: string, token: ModelIdentity) => run(token, (s, t) => s.parameter.getGeometryParameter(id, parm, t)),
      getCrossSectionParameter: (id: string, parm: string, token: ModelIdentity) => run(token, (s, t) => s.parameter.getCrossSectionParameter(id, parm, t)),
      set: async (_input: ParameterWriteInput, token: ModelIdentity): Promise<{ actual: number }> => { identity(token); throw new ModelingError('UNSUPPORTED_OPERATION', 'Parameter writes are disabled pending reentrancy safety review') },
    },
    write: {
      create: async (_input: CreateGeometryInput, token: ModelIdentity): Promise<{ geometryId: string }> => { identity(token); throw new ModelingError('UNSUPPORTED_OPERATION', 'Geometry creation is disabled pending reentrancy safety review') },
      move: async (_input: MoveGeometryInput, token: ModelIdentity): Promise<{ geometryId: string; origin: [number, number, number] }> => { identity(token); throw new ModelingError('UNSUPPORTED_OPERATION', 'Geometry movement is disabled pending reentrancy safety review') },
    },
    wing: { get: (id: string, token: ModelIdentity) => run(token, (s, t) => s.wing.get(id, t)) },
    fuselage: { get: (id: string, token: ModelIdentity) => run(token, (s, t) => s.fuselage.get(id, t)) },
  }
}
