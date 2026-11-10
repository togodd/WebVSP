import { ModelingError } from './contracts'
import type { Geometry, ModelContext, ModelIdentity } from './contracts'
import type { CrossSectionSurface } from './parameterService'

/** The existing engine-backed read services, injected without owning their lifecycle. */
export interface WingReadDependencies {
  geometry: { get(geometryId: string, identity?: ModelIdentity): Promise<{ context: ModelContext; geometry: Geometry }> }
  parameters: { listSurfaces(geometryId: string, identity?: ModelIdentity): Promise<CrossSectionSurface[]> }
}

export interface WingStation {
  readonly id: string
  /** Position in this particular read, not a persistent identifier. */
  readonly index: number
  /** Index 0 is the root airfoil XSec, with no inboard wing section. For i > 0,
   * this XSec is the outboard airfoil station of the section from i-1 to i;
   * its WingSect owns that section's parameters. The ID is an XSec ID, not a
   * separate segment ID, and indices can change after topology edits. */
  readonly kind: 'rootAirfoilStation' | 'wingSection'
}
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
 * No driver, airfoil shape, dimensions, or editing support is implied.
 */
export function createWingService(deps: WingReadDependencies) {
  return {
    async get(geometryId: string, identity?: ModelIdentity): Promise<WingView> {
      if (typeof geometryId !== 'string' || !geometryId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'geometryId must be a nonempty string')
      const result = await deps.geometry.get(geometryId, identity)
      if (!result || !result.context || typeof result.context.sessionId !== 'string' || typeof result.context.engineRevision !== 'number' || !Number.isFinite(result.context.engineRevision) || typeof result.context.engineVersion !== 'string') throw new ModelingError('ENGINE_ERROR', 'Invalid geometry response')
      const { context, geometry } = result
      if (!geometry || geometry.id !== geometryId || typeof geometry.type !== 'string' || !geometry.type.trim()) throw new ModelingError('ENGINE_ERROR', 'Invalid geometry response')
      if (geometry.type.toUpperCase() !== 'WING') throw new ModelingError('UNSUPPORTED_OPERATION', 'Geometry is not a wing', { geometryId })
      const surfaces = await deps.parameters.listSurfaces(geometryId, identity)
      const surfaceIds = new Set<string>(), stationIds = new Set<string>()
      const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim()
      if (!Array.isArray(surfaces)) throw new ModelingError('ENGINE_ERROR', 'Invalid wing surface response')
      const view = Array.from(surfaces, (surface): WingSurface => {
        if (!surface || !validId(surface.id) || surfaceIds.has(surface.id) || !Array.isArray(surface.xsecs)) throw new ModelingError('ENGINE_ERROR', 'Invalid wing surface response')
        surfaceIds.add(surface.id)
        const stations = Array.from(surface.xsecs, (id, index): WingStation => {
          if (!validId(id) || stationIds.has(id)) throw new ModelingError('ENGINE_ERROR', 'Invalid wing surface response')
          stationIds.add(id)
          return { id, index, kind: index === 0 ? 'rootAirfoilStation' : 'wingSection' }
        })
        return { id: surface.id, stations }
      })
      return { geometryId, context: { ...context }, surfaces: view }
    },
  }
}
