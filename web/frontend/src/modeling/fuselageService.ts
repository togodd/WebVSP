import { ModelingError } from './contracts'
import type { Geometry, ModelContext, ModelIdentity } from './contracts'
import type { EngineParameter, CrossSectionShapeSurface } from './parameterService'

/** Only the existing read operations are required; no engine or UI state is captured. */
export interface FuselageGeometryReader {
  get(geometryId: string, identity?: ModelIdentity): Promise<{ context: ModelContext; geometry: Geometry }>
}
export interface FuselageParameterReader {
  getFuselageLength(geometryId: string, identity?: ModelIdentity): Promise<EngineParameter>
  listFuselageShapes(geometryId: string, identity?: ModelIdentity): Promise<CrossSectionShapeSurface[]>
}
export interface FuselageSection {
  id: string
  /** Zero-based index within this XSec surface, not an index across all surfaces. */
  index: number
  /** Observed native XSEC_CRV_TYPE integer; unknown values are preserved. */
  shape: number
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

// Only response inspection is guarded: dependency rejections must propagate unchanged.
function inspect<T>(fn: () => T): T {
  try { return fn() } catch { return badData('Invalid Fuselage response') }
}
function snapshotArray<T, U>(value: T[], item: (value: T, index: number) => U): U[] {
  if (!Array.isArray(value)) return badData('Invalid array')
  const length = value.length
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) return badData('Invalid array length')
  const result: U[] = []
  for (let i = 0; i < length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return badData('Sparse array')
    result.push(item(value[i], i))
  }
  return result
}

/**
 * Read-only, linkable-parameter view of a Fuselage. Requests are independent async
 * reads, not a transaction. ID/owner validation catches some inconsistent results,
 * but cannot guarantee atomicity or detect a model replacement that reuses IDs.
 * Shape is an observed native curve type, not a permanent ID or parameter guarantee.
 * Dimensions other than Design/Length and derived geometry are not inferred.
 * Dependency errors (including SESSION_CLOSED) propagate unchanged.
 */
export function createFuselageService(geometry: FuselageGeometryReader, parameter: FuselageParameterReader) {
  return {
    async get(geometryId: string, identity?: ModelIdentity): Promise<FuselageSnapshot> {
      if (!validId(geometryId)) throw new ModelingError('INVALID_ARGUMENT', 'geometryId must be a nonempty string')
      const info = await geometry.get(geometryId, identity)
      const initial = inspect(() => {
        if (!info) return badData('Invalid geometry response')
        const sourceGeometry = info.geometry, sourceContext = info.context
        if (!sourceGeometry || !sourceContext) return badData('Invalid geometry response')
        const context = { ...sourceContext }
        const { id, type, childIds, ...otherGeometry } = sourceGeometry
        const result = { ...otherGeometry, id, type, childIds: snapshotArray(childIds, id => id) }
        if (result.id !== geometryId) return badData('Geometry response does not match the requested ID')
        return { context, geometry: result }
      })
      if (initial.geometry.type !== 'FUSELAGE' && initial.geometry.type !== 'Fuselage') throw new ModelingError('UNSUPPORTED_OPERATION', 'Geometry is not a Fuselage', { geometryId })

      // The engine enforces uniqueness; still validate the returned identity and metadata.
      const rawLength = await parameter.getFuselageLength(geometryId, identity)
      const length = inspect(() => {
        if (!rawLength) return badData('Invalid Fuselage Design/Length parameter')
        const { id, name, group, container, value, lowerLimit, upperLimit, ...otherLength } = rawLength
        const result = { ...otherLength, id, name, group, container, value, lowerLimit, upperLimit }
        if (!validId(result.id) || result.name !== 'Length' || result.group !== 'Design' || result.container !== geometryId) return badData('Invalid Fuselage Design/Length parameter')
        if (typeof result.value !== 'number' || !Number.isFinite(result.value) ||
            typeof result.lowerLimit !== 'number' || !Number.isFinite(result.lowerLimit) ||
            typeof result.upperLimit !== 'number' || !Number.isFinite(result.upperLimit)) return badData('Fuselage Length has a non-finite value or limit')
        return result
      })

      const raw = await parameter.listFuselageShapes(geometryId, identity)
      const surfaces = inspect(() => {
        const surfaceIds = new Set<string>(), sectionIds = new Set<string>()
        return snapshotArray(raw, (surface, index): FuselageSurface => {
          if (!surface) return badData('Invalid or ambiguous XSec surface')
          const id = surface.id, xsecs = surface.xsecs
          if (!validId(id) || surfaceIds.has(id)) return badData('Invalid or ambiguous XSec surface')
          surfaceIds.add(id)
          const sections = snapshotArray(xsecs, (section, index): FuselageSection => {
            if (!section) return badData('Invalid XSec')
            const sectionId = section.id, shape = section.shape
            if (!validId(sectionId) || sectionIds.has(sectionId)) return badData('Invalid or ambiguous XSec ID')
            if (!Number.isInteger(shape) || shape < -2147483648 || shape > 2147483647 || shape === -1) return badData('Invalid XSec shape')
            sectionIds.add(sectionId)
            return { id: sectionId, index, shape }
          })
          return { id, index, sections }
        })
      })
      return { ...initial, length, surfaces }
    },
  }
}
