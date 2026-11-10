import type { BBox, ModelTree } from '../api/types'
import { MODELING_CONTRACT_VERSION, ModelingError } from './contracts'
import type { Bounds, Capability, Geometry, ModelInfo } from './contracts'

/** Minimal read interface. Implementations must read the engine, not cached UI state. */
export interface ModelingReadAdapter {
  model(): Promise<ModelTree>
  bbox(): Promise<BBox | null>
}

const supported = new Set(['model.read', 'geometry.read'])
const capabilityNames: Capability['name'][] = ['model.read', 'geometry.read', 'geometry.create', 'geometry.move', 'parameter.read', 'parameter.write', 'wing.edit', 'fuselage.edit', 'assembly.attach']

/** A service belongs to one live engine instance. Revision is an event counter, not a lock. */
export function createReadService(adapter: ModelingReadAdapter, sessionId: string) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'sessionId must not be empty')
  let closed = false
  function checkOpen() {
    if (closed) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
  }
  async function fromEngine<T>(read: () => Promise<T>): Promise<T> {
    checkOpen()
    try {
      const result = await read()
      checkOpen()
      return result
    } catch {
      checkOpen()
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP engine request failed')
    }
  }
  async function getModel(): Promise<ModelInfo> {
    const model = await fromEngine(() => adapter.model())
    return {
      context: { sessionId, engineRevision: model.rev, engineVersion: model.version },
      fileName: model.fileName,
      geometries: model.geoms.map((g): Geometry => ({ id: g.id, name: g.name, type: g.type, parentId: g.parent, childIds: [...g.children], shown: g.shown })),
      selectedGeometryIds: [...model.active],
    }
  }
  return {
    capabilities(): { contractVersion: string; features: Capability[] } {
      checkOpen()
      return { contractVersion: MODELING_CONTRACT_VERSION, features: capabilityNames.map((name) => supported.has(name) ? { name, status: 'supported' } : { name, status: 'unsupported', reason: 'Not implemented or not verified' }) }
    },
    model: {
      getInfo: getModel,
      async getSelection(): Promise<{ context: ModelInfo['context']; geometryIds: string[] }> {
        const info = await getModel()
        return { context: info.context, geometryIds: info.selectedGeometryIds }
      },
      /** Bounds of shown surfaces only, not all model geometry; a separate non-atomic read. */
      getVisibleSurfaceBounds(): Promise<Bounds | null> {
        return fromEngine(() => adapter.bbox())
      },
    },
    geometry: {
      async list(): Promise<{ context: ModelInfo['context']; geometries: Geometry[] }> {
        const info = await getModel()
        return { context: info.context, geometries: info.geometries }
      },
      async get(geometryId: string): Promise<{ context: ModelInfo['context']; geometry: Geometry }> {
        checkOpen()
        if (typeof geometryId !== 'string' || !geometryId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'geometryId must be a nonempty string')
        const info = await getModel()
        const geometry = info.geometries.find((g) => g.id === geometryId)
        if (!geometry) throw new ModelingError('GEOMETRY_NOT_FOUND', 'Geometry does not exist', { geometryId })
        return { context: info.context, geometry }
      },
    },
    close() { closed = true },
  }
}
