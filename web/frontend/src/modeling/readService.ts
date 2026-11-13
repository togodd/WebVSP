import type { BBox, ModelTree } from '../api/types'
import { MODELING_CONTRACT_VERSION, ModelingError } from './contracts'
import type { Bounds, Capability, Geometry, ModelIdentity, ModelInfo } from './contracts'

/** Minimal read interface. Implementations must read the engine, not cached UI state. */
export interface ModelingReadAdapter {
  /** Implementations may use expectedIdentity for an engine-guarded snapshot. */
  model(expectedIdentity?: ModelIdentity): Promise<ModelTree>
  bbox(): Promise<BBox | null>
  /** Available when the adapter can guard the geometry type read. */
  geomTypes?(): Promise<string[]>
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

// Engine responses are untrusted at runtime despite the adapter's static types. Copy
// validated fields so neither extra properties nor later mutations escape the service.
function copyArray<T>(value: unknown, copyItem: (item: unknown) => T, checkOpen: () => void, expectedLength?: number): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid array')
  const length = value.length
  checkOpen()
  if (!Number.isSafeInteger(length) || length < 0 || (expectedLength !== undefined && length !== expectedLength)) throw new Error('Invalid array length')
  const copy: T[] = []
  for (let i = 0; i < length; i++) {
    const hasItem = Object.prototype.hasOwnProperty.call(value, i)
    checkOpen()
    if (!hasItem) throw new Error('Sparse array')
    const item = value[i]
    checkOpen()
    copy.push(copyItem(item))
    checkOpen()
  }
  return copy
}

function stringArray(value: unknown, checkOpen: () => void): string[] {
  return copyArray(value, (item) => {
    if (typeof item !== 'string') throw new Error('Invalid string')
    return item
  }, checkOpen)
}

function boundsVector(value: unknown, checkOpen: () => void): [number, number, number] {
  const copy = copyArray(value, (item) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('Invalid bounds')
    return item
  }, checkOpen, 3)
  return [copy[0], copy[1], copy[2]]
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
  // Each untrusted property access is a separate reentrancy boundary.
  function field<T, K extends keyof T>(object: T, key: K): T[K] {
    const value = object[key]
    checkOpen()
    return value
  }
  async function fromEngine<T>(read: () => Promise<T>): Promise<T> {
    checkOpen()
    try {
      const result = await raceClose(controller.signal, read)
      checkOpen()
      return result
    } catch (error) {
      checkOpen()
      let stale = false
      try {
        const modelingError = error instanceof ModelingError
        checkOpen()
        if (modelingError) {
          stale = error.code === 'STALE_MODEL'
          checkOpen()
        }
      } catch {
        checkOpen()
      }
      if (stale) throw new ModelingError('STALE_MODEL', 'The model identity is stale')
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP engine request failed')
    }
  }
  // Match the engine's canonical uint64 representation without losing precision.
  const validEpoch = (epoch: unknown): epoch is string => typeof epoch === 'string' && /^(0|[1-9][0-9]*)$/.test(epoch) && (epoch.length < 20 || (epoch.length === 20 && epoch <= '18446744073709551615'))
  async function getModel(expectedIdentity?: ModelIdentity): Promise<ModelInfo> {
    checkOpen()
    let validatedIdentity: ModelIdentity | undefined
    if (expectedIdentity !== undefined) {
      let tokenSessionId: unknown, modelEpoch: unknown
      try {
        if (expectedIdentity == null) throw new Error('Invalid identity')
        tokenSessionId = field(expectedIdentity, 'sessionId')
        modelEpoch = field(expectedIdentity, 'modelEpoch')
      } catch {
        checkOpen()
        throw new ModelingError('INVALID_ARGUMENT', 'Expected identity is invalid')
      }
      checkOpen()
      if (typeof tokenSessionId !== 'string' || !tokenSessionId.trim() || !validEpoch(modelEpoch)) throw new ModelingError('INVALID_ARGUMENT', 'Expected identity is invalid')
      if (tokenSessionId !== sessionId) throw new ModelingError('STALE_MODEL', 'Model identity does not match this session')
      validatedIdentity = { sessionId: tokenSessionId, modelEpoch }
    }
    let info: ModelInfo
    try {
      info = await fromEngine(async () => {
        // The adapter must not be able to alter the values used for our comparison.
        const method = field(adapter, 'model')
        const model = await Reflect.apply(method, adapter, validatedIdentity ? [{ ...validatedIdentity }] : [])
        checkOpen()
        try {
          if (!model) throw new Error('Invalid model identity')
          const modelEpoch = field(model, 'modelEpoch')
          if (field(model, 'modelEpochValid') !== true || !validEpoch(modelEpoch)) throw new Error('Invalid model identity')
          const rev = field(model, 'rev'), version = field(model, 'version'), fileName = field(model, 'fileName'), geoms = field(model, 'geoms'), active = field(model, 'active')
          if (typeof rev !== 'number' || !Number.isFinite(rev) || typeof version !== 'string' || typeof fileName !== 'string' || !Array.isArray(geoms)) throw new Error('Invalid model')
          const geometryIds = new Set<string>()
          const geometries = copyArray(geoms, (g): Geometry => {
            if (!g || typeof g !== 'object') throw new Error('Invalid geometry')
            const record = g as Record<string, unknown>
            const id = field(record, 'id'), name = field(record, 'name'), type = field(record, 'type'), parent = field(record, 'parent'), children = field(record, 'children'), shown = field(record, 'shown')
            if (typeof id !== 'string' || !id.trim() || geometryIds.has(id) || typeof name !== 'string' || typeof type !== 'string' || (parent !== null && typeof parent !== 'string') || typeof shown !== 'boolean') throw new Error('Invalid geometry')
            geometryIds.add(id)
            return { id, name, type, parentId: parent, childIds: stringArray(children, checkOpen), shown }
          }, checkOpen)
          return {
            identity: { sessionId, modelEpoch },
            context: { sessionId, engineRevision: rev, engineVersion: version },
            fileName,
            geometries,
            selectedGeometryIds: stringArray(active, checkOpen),
          }
        } catch {
          throw new Error('Invalid model response')
        }
      })
    } catch (error) {
      checkOpen()
      throw error
    }
    checkOpen()
    if (validatedIdentity && info.identity.modelEpoch !== validatedIdentity.modelEpoch) throw new ModelingError('STALE_MODEL', 'Model identity does not match the snapshot')
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
        let info: ModelInfo
        try { info = await getModel() } catch (error) { checkOpen(); throw error }
        checkOpen()
        return { context: info.context, geometryIds: info.selectedGeometryIds }
      },
      /** Bounds of shown surfaces only, not all model geometry; a separate non-atomic read. */
      getVisibleSurfaceBounds(): Promise<Bounds | null> {
        return fromEngine(async () => {
          const method = field(adapter, 'bbox')
          const bbox = await Reflect.apply(method, adapter, [])
          checkOpen()
          try {
            if (bbox === null) return null
            if (!bbox || typeof bbox !== 'object') throw new Error('Invalid bounds')
            return { min: boundsVector(field(bbox, 'min'), checkOpen), max: boundsVector(field(bbox, 'max'), checkOpen) }
          } catch {
            throw new Error('Invalid bounds response')
          }
        })
      },
    },
    geometry: {
      listTypes(): Promise<string[]> {
        return fromEngine(async () => {
          const method = field(adapter, 'geomTypes')
          if (!method) throw new Error('Geometry types unavailable')
          const types = await Reflect.apply(method, adapter, [])
          checkOpen()
          try { return stringArray(types, checkOpen) } catch { throw new Error('Invalid geometry types response') }
        })
      },
      async list(): Promise<{ context: ModelInfo['context']; geometries: Geometry[] }> {
        let info: ModelInfo
        try { info = await getModel() } catch (error) { checkOpen(); throw error }
        checkOpen()
        return { context: info.context, geometries: info.geometries }
      },
      /** Optional identity compares this snapshot only; it does not guard later operations. */
      async get(geometryId: string, expectedIdentity?: ModelIdentity): Promise<{ context: ModelInfo['context']; geometry: Geometry }> {
        checkOpen()
        if (typeof geometryId !== 'string' || !geometryId.trim()) throw new ModelingError('INVALID_ARGUMENT', 'geometryId must be a nonempty string')
        let info: ModelInfo
        try { info = await getModel(expectedIdentity) } catch (error) { checkOpen(); throw error }
        checkOpen()
        const geometry = info.geometries.find((g) => g.id === geometryId)
        if (!geometry) throw new ModelingError('GEOMETRY_NOT_FOUND', 'Geometry does not exist', { geometryId })
        return { context: info.context, geometry }
      },
    },
    close() { controller.abort() },
  }
}
