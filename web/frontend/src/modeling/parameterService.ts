import { ModelingError } from './contracts'

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
  surfaces(geometryId: string): Promise<CrossSectionSurface[]>
  list(owner: 'geometry' | 'crossSection', ownerId: string): Promise<string[]>
  get(owner: 'geometry' | 'crossSection', ownerId: string, parameterId: string): Promise<EngineParameter>
}
function id(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ModelingError('INVALID_ARGUMENT', `${field} must be a nonempty string`)
  return value
}
export function createParameterService(adapter: ParameterReadAdapter, isClosed: () => boolean = () => false) {
  function checkOpen() { if (isClosed()) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed') }
  async function read<T>(fn: () => Promise<T>): Promise<T> {
    checkOpen()
    try { const result = await fn(); checkOpen(); return result } catch { checkOpen(); throw new ModelingError('ENGINE_ERROR', 'The OpenVSP parameter request failed') }
  }
  return {
    /** Only surfaces and cross sections reachable through the current model's geometry. */
    listSurfaces(geometryId: string) { const owner = id(geometryId, 'geometryId'); return read(() => adapter.surfaces(owner)) },
    /** IDs returned by OpenVSP's linkable parameter list; not all internal parameters. */
    listGeometryParameterIds(geometryId: string) { const owner = id(geometryId, 'geometryId'); return read(() => adapter.list('geometry', owner)) },
    listCrossSectionParameterIds(sectionId: string) { const owner = id(sectionId, 'sectionId'); return read(() => adapter.list('crossSection', owner)) },
    getGeometryParameter(geometryId: string, parameterId: string) { const owner = id(geometryId, 'geometryId'), parm = id(parameterId, 'parameterId'); return read(() => adapter.get('geometry', owner, parm)) },
    getCrossSectionParameter(sectionId: string, parameterId: string) { const owner = id(sectionId, 'sectionId'), parm = id(parameterId, 'parameterId'); return read(() => adapter.get('crossSection', owner, parm)) },
  }
}
