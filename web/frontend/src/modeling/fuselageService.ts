import { ModelingError } from './contracts'
import type { Geometry, ModelContext } from './contracts'
import type { EngineParameter, CrossSectionSurface } from './parameterService'

/** Only the existing read operations are required; no engine or UI state is captured. */
export interface FuselageGeometryReader {
  get(geometryId: string): Promise<{ context: ModelContext; geometry: Geometry }>
}
export interface FuselageParameterReader {
  getFuselageLength(geometryId: string): Promise<EngineParameter>
  listSurfaces(geometryId: string): Promise<CrossSectionSurface[]>
}
export interface FuselageSection {
  id: string
  /** Zero-based index within this XSec surface, not an index across all surfaces. */
  index: number
  /** This read API does not expose the section's shape. */
  shape: null
}
export interface FuselageSurface { id: string; index: number; sections: FuselageSection[] }
export interface FuselageSnapshot {
  /** Context of the initial geometry read only, not a snapshot revision. */
  context: ModelContext
  geometry: Geometry
  length: EngineParameter
  surfaces: FuselageSurface[]
}

function validId(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function badData(message: string): never { throw new ModelingError('ENGINE_ERROR', message) }

/**
 * Read-only, linkable-parameter view of a Fuselage. Requests are independent async
 * reads, not a transaction. ID/owner validation catches some inconsistent results,
 * but cannot guarantee atomicity or detect a model replacement that reuses IDs.
 * Shape, dimensions other than Design/Length, and derived geometry are not inferred.
 * Dependency errors (including SESSION_CLOSED) propagate unchanged.
 */
export function createFuselageService(geometry: FuselageGeometryReader, parameter: FuselageParameterReader) {
  return {
    async get(geometryId: string): Promise<FuselageSnapshot> {
      if (!validId(geometryId)) throw new ModelingError('INVALID_ARGUMENT', 'geometryId must be a nonempty string')
      const info = await geometry.get(geometryId)
      if (!info.geometry || info.geometry.id !== geometryId) badData('Geometry response does not match the requested ID')
      if (info.geometry.type !== 'Fuselage') throw new ModelingError('UNSUPPORTED_OPERATION', 'Geometry is not a Fuselage', { geometryId })

      // The engine enforces uniqueness; still validate the returned identity and metadata.
      const length = await parameter.getFuselageLength(geometryId)
      if (!length || !validId(length.id) || length.name !== 'Length' || length.group !== 'Design' || length.container !== geometryId) badData('Invalid Fuselage Design/Length parameter')
      if (typeof length.value !== 'number' || !Number.isFinite(length.value) ||
          typeof length.lowerLimit !== 'number' || !Number.isFinite(length.lowerLimit) ||
          typeof length.upperLimit !== 'number' || !Number.isFinite(length.upperLimit)) badData('Fuselage Length has a non-finite value or limit')

      const raw = await parameter.listSurfaces(geometryId)
      if (!Array.isArray(raw)) badData('Invalid XSec surfaces')
      const surfaceIds = new Set<string>(), sectionIds = new Set<string>()
      const surfaces = raw.map((surface, index): FuselageSurface => {
        if (!surface || !validId(surface.id) || surfaceIds.has(surface.id) || !Array.isArray(surface.xsecs)) badData('Invalid or ambiguous XSec surface')
        surfaceIds.add(surface.id)
        const sections = surface.xsecs.map((id, index): FuselageSection => {
          if (!validId(id) || sectionIds.has(id)) badData('Invalid or ambiguous XSec ID')
          sectionIds.add(id)
          return { id, index, shape: null }
        })
        return { id: surface.id, index, sections }
      })
      return { context: info.context, geometry: info.geometry, length: { ...length }, surfaces }
    },
  }
}
