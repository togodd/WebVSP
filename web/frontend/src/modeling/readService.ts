import type { BBox, ModelTree } from '../api/types'
import { MODELING_CONTRACT_VERSION, ModelingError } from './contracts'
import type { Bounds, Capability, Geometry, ModelIdentity, ModelInfo } from './contracts'

/** Minimal read interface. Implementations must read the engine, not cached UI state. */
export interface ModelingReadAdapter {
  /** Implementations may use expectedIdentity for an engine-guarded snapshot. */
  model(expectedIdentity?: ModelIdentity): Promise<ModelTree>
  bbox(): Promise<BBox | null>
}

// Attach handlers to the engine promise even after close, so late rejections are consumed.
export function raceClose<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const closed = () => reject(new ModelingError('SESSION_CLOSED', 'Modeling session is closed'))
    if (signal.aborted) { closed(); return }
    signal.addEventListener('abort', closed, { once: true })
    try {
      Promise.resolve(fn()).then(resolve, reject).finally(() => signal.removeEventListener('abort', closed))
    } catch (error) {
      signal.removeEventListener('abort', closed)
      reject(error)
    }
  })
}

const supported = new Set(['model.read', 'geometry.read'])
const capabilityNames: Capability['name'][] = ['model.read', 'geometry.read', 'geometry.create', 'geometry.move', 'parameter.read', 'parameter.write', 'wing.read', 'wing.edit', 'fuselage.read', 'fuselage.edit', 'assembly.attach']

/** A service belongs to one live engine instance. Revision is an event counter, not a lock. */
export function createReadService(adapter: ModelingReadAdapter, sessionId: string) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'sessionId must not be empty')
  const controller = new AbortController()
  function checkOpen() {
    if (controller.signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
  }
  async function fromEngine<T>(read: () => Promise<T>): Promise<T> {
    checkOpen()
    try {
      const result = await raceClose(controller.signal, read)
      checkOpen()
      return result
    } catch (error) {
      checkOpen()
      if (error instanceof ModelingError && error.code === 'STALE_MODEL') throw error
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP engine request failed')
    }
  }
  // Match the engine's canonical uint64 representation without losing precision.
  const validEpoch = (epoch: unknown): epoch is string => typeof epoch === 'string' && /^(0|[1-9][0-9]*)$/.test(epoch) && (epoch.length < 20 || (epoch.length === 20 && epoch <= '18446744073709551615'))
  async function getModel(expectedIdentity?: ModelIdentity): Promise<ModelInfo> {
    checkOpen()
    if (expectedIdentity !== undefined) {
      if (!expectedIdentity) throw new ModelingError('INVALID_ARGUMENT', 'Expected identity is invalid')
      const { sessionId: tokenSessionId, modelEpoch } = expectedIdentity
      if (typeof tokenSessionId !== 'string' || !tokenSessionId.trim() || !validEpoch(modelEpoch)) throw new ModelingError('INVALID_ARGUMENT', 'Expected identity is invalid')
      if (tokenSessionId !== sessionId) throw new ModelingError('STALE_MODEL', 'Model identity does not match this session')
      // Copy the validated values before the asynchronous read.
      expectedIdentity = { sessionId: tokenSessionId, modelEpoch }
    }
    const info = await fromEngine(async () => {
      const model = expectedIdentity ? await adapter.model(expectedIdentity) : await adapter.model()
      if (!model) throw new Error('Invalid model identity')
      const modelEpoch = model.modelEpoch
      if (model.modelEpochValid !== true || !validEpoch(modelEpoch)) throw new Error('Invalid model identity')
      return {
        identity: { sessionId, modelEpoch },
        context: { sessionId, engineRevision: model.rev, engineVersion: model.version },
        fileName: model.fileName,
        geometries: model.geoms.map((g): Geometry => ({ id: g.id, name: g.name, type: g.type, parentId: g.parent, childIds: [...g.children], shown: g.shown })),
        selectedGeometryIds: [...model.active],
      }
    })
    if (expectedIdentity && info.identity.modelEpoch !== expectedIdentity.modelEpoch) throw new ModelingError('STALE_MODEL', 'Model identity does not match the snapshot')
    return info
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
      /** Optional identity compares this snapshot only; it does not guard later operations. */
      async get(geometryId: string, expectedIdentity?: ModelIdentity): Promise<{ context: ModelInfo['context']; geometry: Geometry }> {
        checkOpen()
        if (typeof geometryId !== 'string' || !geometryId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'geometryId must be a nonempty string')
        const info = await getModel(expectedIdentity)
        const geometry = info.geometries.find((g) => g.id === geometryId)
        if (!geometry) throw new ModelingError('GEOMETRY_NOT_FOUND', 'Geometry does not exist', { geometryId })
        return { context: info.context, geometry }
      },
    },
    close() { controller.abort() },
  }
}
