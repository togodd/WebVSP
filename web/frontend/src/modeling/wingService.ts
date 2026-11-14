import { ModelingError } from './contracts'
import type { Geometry, ModelContext, ModelIdentity } from './contracts'
import type { CrossSectionShapeSurface, EngineParameter } from './parameterService'

/** The existing engine-backed read services, injected without owning their lifecycle. */
export interface WingReadDependencies {
  geometry: { get(geometryId: string, identity?: ModelIdentity): Promise<{ context: ModelContext; geometry: Geometry }> }
  parameters: {
    listWingShapes(geometryId: string, identity?: ModelIdentity): Promise<CrossSectionShapeSurface[]>
    listCrossSectionParameterIds(sectionId: string, identity?: ModelIdentity): Promise<string[]>
    getCrossSectionParameter(sectionId: string, parameterId: string, identity?: ModelIdentity): Promise<EngineParameter>
  }
}

export interface WingStation {
  readonly id: string
  /** Position in this particular read, not a persistent identifier. */
  readonly index: number
  /** Native XSEC_CRV_TYPE observed during this read; unknown values are preserved. */
  readonly shape: number
  /** Index 0 is the root airfoil XSec, with no inboard wing section. For i > 0,
   * this XSec is the outboard airfoil station of the section from i-1 to i;
   * its WingSect owns that section's parameters. The ID is an XSec ID, not a
   * separate segment ID, and indices can change after topology edits. */
  readonly kind: 'rootAirfoilStation' | 'wingSection'
}
export interface WingDimensions { readonly span: number; readonly rootChord: number; readonly tipChord: number }
export interface WingSurface {
  readonly id: string
  readonly stations: readonly WingStation[]
}
export interface WingView {
  readonly geometryId: string
  /** Context from the geometry read only; it does not version the surface read. */
  readonly context: Readonly<ModelContext>
  readonly surfaces: readonly WingSurface[]
}

/**
 * Reads geometry first, then its XSec surfaces. These are separate requests, not an
 * atomic snapshot or a lock: concurrent edits/deletion/replacement can make the
 * result stale or combine observations from different states. The geometry type
 * check cannot guarantee that the later surface response still belongs to that
 * same wing. Callers needing consistency must coordinate all model mutations
 * externally, including GUI edits. Revisions and indices are not persistence tokens.
 * Shape and dimensions are observed native values, not guarantees of editable parameters.
 * Individual dimension reads are separate requests; no driver or editing support is implied.
 */
export function createWingService(deps: WingReadDependencies) {
  async function dimensions(sectionId: string, identity?: ModelIdentity): Promise<WingDimensions> {
    const ids = await deps.parameters.listCrossSectionParameterIds(sectionId, identity)
    let copy: string[]
    try {
      if (!Array.isArray(ids)) throw new Error('Invalid IDs')
      const seen = new Set<string>(); copy = []
      const length = ids.length
      if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) throw new Error('Invalid length')
      for (let i = 0; i < length; i++) {
        if (!Object.prototype.hasOwnProperty.call(ids, i)) throw new Error('Sparse IDs')
        const id = ids[i]
        if (typeof id !== 'string' || !id.trim() || seen.has(id)) throw new Error('Invalid ID')
        seen.add(id); copy.push(id)
      }
    } catch { throw new ModelingError('ENGINE_ERROR', 'Invalid wing parameter IDs') }
    const found = new Map<string, number>()
    for (const id of copy) {
      const parm = await deps.parameters.getCrossSectionParameter(sectionId, id, identity)
      try {
        const name = parm.name, group = parm.group, container = parm.container, parmId = parm.id
        if (parmId !== id || typeof name !== 'string' || typeof group !== 'string' || typeof container !== 'string') throw new Error('Invalid metadata')
        if (container === sectionId && group === 'XSec' && (name === 'Span' || name === 'Root_Chord' || name === 'Tip_Chord')) {
          const value = parm.value, type = parm.type
          if (found.has(name) || type !== 0 || typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid dimension')
          found.set(name, value)
        }
      } catch { throw new ModelingError('ENGINE_ERROR', 'Invalid wing parameter response') }
    }
    if (found.size !== 3) throw new ModelingError('ENGINE_ERROR', 'Missing wing section dimensions')
    return { span: found.get('Span')!, rootChord: found.get('Root_Chord')!, tipChord: found.get('Tip_Chord')! }
  }
  const service = {
    /** Separate, opt-in reads. Ownership may change between jobs, including delete/recreate
     * with reused IDs; identity guards do not detect ordinary topology edits (ABA). */
    async getSectionDimensions(geometryId: string, sectionId: string, identity?: ModelIdentity): Promise<WingDimensions> {
      if (typeof sectionId !== 'string' || !sectionId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'sectionId must be a nonempty string')
      const wing = await service.get(geometryId, identity)
      const station = wing.surfaces.flatMap(surface => surface.stations).find(item => item.id === sectionId)
      if (!station || station.index === 0) throw new ModelingError('INVALID_ARGUMENT', 'sectionId must identify a non-root wing station')
      return dimensions(sectionId, identity)
    },
    async get(geometryId: string, identity?: ModelIdentity): Promise<WingView> {
      if (typeof geometryId !== 'string' || !geometryId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'geometryId must be a nonempty string')
      const result = await deps.geometry.get(geometryId, identity)
      // Dependency rejections are deliberately outside these parsing guards: their
      // declared errors (and identity) belong to the dependency, not this adapter.
      let context: ModelContext, geometryType: string
      try {
        const sourceContext = result.context, geometry = result.geometry
        const sessionId = sourceContext.sessionId, engineRevision = sourceContext.engineRevision, engineVersion = sourceContext.engineVersion
        const id = geometry.id, type = geometry.type
        if (typeof sessionId !== 'string' || typeof engineRevision !== 'number' || !Number.isFinite(engineRevision) || typeof engineVersion !== 'string' || id !== geometryId || typeof type !== 'string' || !type.trim()) throw new Error('Invalid geometry')
        context = { sessionId, engineRevision, engineVersion }
        geometryType = type
      } catch {
        throw new ModelingError('ENGINE_ERROR', 'Invalid geometry response')
      }
      if (geometryType.toUpperCase() !== 'WING') throw new ModelingError('UNSUPPORTED_OPERATION', 'Geometry is not a wing', { geometryId })
      const surfaces = await deps.parameters.listWingShapes(geometryId, identity)
      let view: WingSurface[]
      try {
        const surfaceIds = new Set<string>(), stationIds = new Set<string>()
        const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim()
        const lengthOf = (array: unknown): number => {
          if (!Array.isArray(array)) throw new Error('Expected array')
          const length = array.length
          if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) throw new Error('Invalid array length')
          return length
        }
        const length = lengthOf(surfaces)
        view = []
        for (let i = 0; i < length; i++) {
          if (!Object.prototype.hasOwnProperty.call(surfaces, i)) throw new Error('Sparse surfaces')
          const surface = surfaces[i]
          const id = surface.id, xsecs = surface.xsecs
          if (!validId(id) || surfaceIds.has(id)) throw new Error('Invalid surface')
          surfaceIds.add(id)
          const count = lengthOf(xsecs), stations: WingStation[] = []
          for (let index = 0; index < count; index++) {
            if (!Object.prototype.hasOwnProperty.call(xsecs, index)) throw new Error('Sparse stations')
            const section = xsecs[index]
            const stationId = section.id, shape = section.shape
            if (!validId(stationId) || stationIds.has(stationId) || typeof shape !== 'number' || !Number.isInteger(shape) || shape < -2147483648 || shape > 2147483647 || shape === -1) throw new Error('Invalid station')
            stationIds.add(stationId)
            stations.push({ id: stationId, index, kind: index === 0 ? 'rootAirfoilStation' : 'wingSection', shape })
          }
          view.push({ id, stations })
        }
      } catch {
        throw new ModelingError('ENGINE_ERROR', 'Invalid wing surface response')
      }
      return { geometryId, context, surfaces: view }
    },
  }
  return service
}
