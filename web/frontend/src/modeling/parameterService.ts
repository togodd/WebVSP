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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isId(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function isNumberOrNull(value: unknown): boolean { return value === null || (typeof value === 'number' && Number.isFinite(value)) }
function isParameter(value: unknown): value is EngineParameter {
  return isRecord(value) && isId(value.id) && isNumberOrNull(value.value) &&
    typeof value.type === 'number' && Number.isInteger(value.type) &&
    typeof value.name === 'string' && typeof value.group === 'string' && typeof value.container === 'string' &&
    isNumberOrNull(value.lowerLimit) && isNumberOrNull(value.upperLimit) && typeof value.active === 'boolean'
}
function isIds(value: unknown): value is string[] { return Array.isArray(value) && value.every(isId) }
function isSurfaces(value: unknown): value is CrossSectionSurface[] {
  return Array.isArray(value) && value.every(surface => isRecord(surface) && isId(surface.id) && isIds(surface.xsecs))
}
export function createParameterService(adapter: ParameterReadAdapter, signal: AbortSignal = new AbortController().signal) {
  function checkOpen() { if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed') }
  async function read<T>(fn: () => Promise<T>, valid: (result: unknown) => boolean, identity?: ModelIdentity): Promise<T> {
    checkOpen()
    try { const result = await raceClose(signal, fn); checkOpen(); if (!valid(result)) throw new Error('Invalid parameter response'); return result } catch (error) {
      checkOpen()
      if (identity !== undefined && error instanceof WasmEngineError && error.code === 'STALE_MODEL') throw new ModelingError('STALE_MODEL', 'The model identity is stale')
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP parameter request failed')
    }
  }
  return {
    /** Only surfaces and cross sections reachable through the current model's geometry. */
    listSurfaces(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? adapter.surfaces(owner) : adapter.surfaces(owner, identity), isSurfaces, identity) },
    /** The engine resolves and checks the unique geometry-owned Design/Length parameter. */
    getFuselageLength(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? adapter.fuselageLength(owner) : adapter.fuselageLength(owner, identity), result => isParameter(result) && result.name === 'Length' && result.group === 'Design' && result.container === owner, identity) },
    /** IDs returned by OpenVSP's linkable parameter list; not all internal parameters. */
    listGeometryParameterIds(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? adapter.list('geometry', owner) : adapter.list('geometry', owner, identity), isIds, identity) },
    listCrossSectionParameterIds(sectionId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'); return read(() => identity === undefined ? adapter.list('crossSection', owner) : adapter.list('crossSection', owner, identity), isIds, identity) },
    getGeometryParameter(geometryId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? adapter.get('geometry', owner, parm) : adapter.get('geometry', owner, parm, identity), result => isParameter(result) && result.id === parm, identity) },
    getCrossSectionParameter(sectionId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? adapter.get('crossSection', owner, parm) : adapter.get('crossSection', owner, parm, identity), result => isParameter(result) && result.id === parm, identity) },
  }
}
