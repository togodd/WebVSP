import { WasmEngineError } from '../api/wasmEngine'
import { ModelingError, type ModelIdentity } from './contracts'
import { raceClose } from './readService'

/** OpenVSP reports linkable parameters only; null represents a non-finite engine value. */
export interface EngineParameter {
  id: string
  value: number | null
  type: number
  name: string
  group: string
  container: string
  lowerLimit: number | null
  upperLimit: number | null
  /** OpenVSP active flag; not a guarantee that all GUI/driver constraints permit editing. */
  active: boolean
}
export interface CrossSectionSurface { id: string; xsecs: string[] }
export interface ParameterReadAdapter {
  surfaces(geometryId: string, identity?: ModelIdentity): Promise<CrossSectionSurface[]>
  fuselageLength(geometryId: string, identity?: ModelIdentity): Promise<EngineParameter>
  list(owner: 'geometry' | 'crossSection', ownerId: string, identity?: ModelIdentity): Promise<string[]>
  get(owner: 'geometry' | 'crossSection', ownerId: string, parameterId: string, identity?: ModelIdentity): Promise<EngineParameter>
}
function id(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ModelingError('INVALID_ARGUMENT', `${field} must be a nonempty string`)
  return value
}
export function createParameterService(adapter: ParameterReadAdapter, signal: AbortSignal = new AbortController().signal) {
  function checkOpen() { if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed') }
  async function read<T>(fn: () => Promise<T>, identity?: ModelIdentity): Promise<T> {
    checkOpen()
    try { const result = await raceClose(signal, fn); checkOpen(); return result } catch (error) {
      checkOpen()
      if (identity !== undefined && error instanceof WasmEngineError && error.code === 'STALE_MODEL') throw new ModelingError('STALE_MODEL', 'The model identity is stale')
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP parameter request failed')
    }
  }
  return {
    /** Only surfaces and cross sections reachable through the current model's geometry. */
    listSurfaces(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? adapter.surfaces(owner) : adapter.surfaces(owner, identity), identity) },
    /** The engine resolves and checks the unique geometry-owned Design/Length parameter. */
    getFuselageLength(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? adapter.fuselageLength(owner) : adapter.fuselageLength(owner, identity), identity) },
    /** IDs returned by OpenVSP's linkable parameter list; not all internal parameters. */
    listGeometryParameterIds(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? adapter.list('geometry', owner) : adapter.list('geometry', owner, identity), identity) },
    listCrossSectionParameterIds(sectionId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'); return read(() => identity === undefined ? adapter.list('crossSection', owner) : adapter.list('crossSection', owner, identity), identity) },
    getGeometryParameter(geometryId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? adapter.get('geometry', owner, parm) : adapter.get('geometry', owner, parm, identity), identity) },
    getCrossSectionParameter(sectionId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? adapter.get('crossSection', owner, parm) : adapter.get('crossSection', owner, parm, identity), identity) },
  }
}
