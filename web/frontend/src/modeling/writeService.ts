import type { ModelTree } from '../api/types'
import { WasmEngineError } from '../api/wasmEngine'
import { ModelingError, type ModelIdentity } from './contracts'
import { raceClose } from './readService'

/** Reads must go to the engine, not a UI cache. Writes may have taken effect even if they reject. */
export interface ModelingWriteAdapter {
  model(identity?: ModelIdentity): Promise<ModelTree>
  geomTypes(identity?: ModelIdentity): Promise<string[]>
  addGeom(type: string, parentId: string | null, identity?: ModelIdentity): Promise<{ id: string }>
  geomOrigin(id: string, identity?: ModelIdentity): Promise<[number, number, number]>
  moveGeoms(ids: string[], delta: [number, number, number], identity?: ModelIdentity): Promise<{ ok: boolean }>
}

export interface CreateGeometryInput { type: string; parentId: string | null }
export interface MoveGeometryInput {
  geometryId: string
  frame: 'world'
  units: 'model-native'
  delta: [number, number, number]
}

/** These operations are not atomic or CAS; readback cannot exclude concurrent edits.
 * Neither undo availability nor persistence is promised. Never automatically retry an unknown outcome. */
export function createWriteService(adapter: ModelingWriteAdapter, signal: AbortSignal = new AbortController().signal) {
  const checkOpen = () => { if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed') }
  const request = <T>(fn: () => Promise<T>) => raceClose(signal, fn)
  const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && !id.includes(',')
  const snapshotVector = (v: unknown): [number, number, number] => {
    if (!Array.isArray(v) || v.length !== 3 || !Object.hasOwn(v, 0) || !Object.hasOwn(v, 1) || !Object.hasOwn(v, 2)) throw new Error('Invalid vector')
    const x = v[0], y = v[1], z = v[2]
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y) || typeof z !== 'number' || !Number.isFinite(z)) throw new Error('Invalid vector')
    return [x, y, z]
  }
  const invalid = (message: string): never => { throw new ModelingError('INVALID_ARGUMENT', message) }
  const snapshotIdentity = (identity: ModelIdentity | undefined): ModelIdentity | undefined => {
    if (identity === undefined) return undefined
    try {
      if (!identity || typeof identity !== 'object') return invalid('Invalid model identity')
      const sessionId = identity.sessionId, modelEpoch = identity.modelEpoch
      checkOpen()
      if (typeof sessionId !== 'string' || !sessionId.trim() || typeof modelEpoch !== 'string' || !modelEpoch.trim()) return invalid('Invalid model identity')
      return { sessionId, modelEpoch }
    } catch {
      checkOpen()
      return invalid('Invalid model identity')
    }
  }
  const identityArgs = (identity: ModelIdentity | undefined): [] | [ModelIdentity] => identity === undefined ? [] : [{ sessionId: identity.sessionId, modelEpoch: identity.modelEpoch }]
  const unknown = (): never => { throw new ModelingError('OUTCOME_UNKNOWN', 'Write may have taken effect; readback could not verify the outcome. Do not automatically retry.') }
  const stale = (): never => { throw new ModelingError('STALE_MODEL', 'The model identity is stale') }
  const isStale = (e: unknown): e is WasmEngineError => e instanceof WasmEngineError && e.code === 'STALE_MODEL'
  const isNotWrittenStale = (e: unknown): boolean => {
    try {
      return !signal.aborted && isStale(e) && !signal.aborted && e.outcome === 'not_written' && !signal.aborted
    } catch {
      return false
    }
  }
  async function readModel(identity?: ModelIdentity): Promise<{ geoms: { id: string; type: string; parent: string | null }[] }> {
    const m = await request(() => adapter.model(...identityArgs(identity)))
    const source = m?.geoms
    if (!Array.isArray(source)) throw new Error('Invalid model')
    const geoms: { id: string; type: string; parent: string | null }[] = []
    const seen = new Set<string>()
    const length = source.length
    if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) throw new Error('Invalid model')
    for (let i = 0; i < length; i++) {
      if (!Object.hasOwn(source, i)) throw new Error('Invalid model')
      const g = source[i]
      if (!g) throw new Error('Invalid model')
      const id = g.id, type = g.type, parent = g.parent
      if (!validId(id) || typeof type !== 'string' || !(parent === null || validId(parent)) || seen.has(id)) throw new Error('Invalid model')
      seen.add(id); geoms.push({ id, type, parent })
    }
    return { geoms }
  }
  async function preflight<T>(read: () => Promise<T>): Promise<T> {
    try { checkOpen(); const result = await read(); checkOpen(); return result } catch (e) {
      checkOpen()
      if (e instanceof ModelingError) throw e
      if (isStale(e)) return stale()
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP engine read failed before writing')
    }
  }
  return {
    async create(input: CreateGeometryInput, inputIdentity?: ModelIdentity): Promise<{ geometryId: string }> {
      checkOpen()
      const identity = snapshotIdentity(inputIdentity)
      let type: string, parentId: string | null
      try {
        if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'parentId')) return invalid('type and explicit parentId are required')
        const t = input.type, p = input.parentId
        if (typeof t !== 'string' || !t.trim() || !(p === null || validId(p))) return invalid('type and explicit parentId are required')
        type = t; parentId = p
      } catch { return invalid('type and explicit parentId are required') }
      const before = await preflight(async () => {
        const [model, types] = await Promise.all([readModel(identity), request(() => adapter.geomTypes(...identityArgs(identity)))])
        if (!Array.isArray(types)) throw new Error('Invalid geometry types')
        const length = types.length
        if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) throw new Error('Invalid geometry types')
        let supported = false
        for (let i = 0; i < length; i++) {
          if (!Object.hasOwn(types, i)) throw new Error('Invalid geometry types')
          const entry = types[i]
          if (typeof entry !== 'string') throw new Error('Invalid geometry types')
          if (entry === type) supported = true
        }
        if (!supported) invalid('Unknown geometry type')
        if (parentId !== null && !model.geoms.some((g) => g.id === parentId)) throw new ModelingError('GEOMETRY_NOT_FOUND', 'Parent geometry does not exist')
        return new Set(model.geoms.map((g) => g.id))
      })
      checkOpen()
      let result: { id: string }
      let dispatched = false
      try {
        result = await request(() => {
          const method = adapter.addGeom
          checkOpen()
          dispatched = true
          return Reflect.apply(method, adapter, [type, parentId, ...identityArgs(identity)])
        })
      } catch (e) {
        if (!dispatched && signal.aborted) checkOpen()
        if (dispatched && isNotWrittenStale(e)) return stale()
        return unknown()
      }
      try {
        if (!result) return unknown()
        const resultId = result.id
        if (!validId(resultId) || before.has(resultId)) return unknown()
        const after = await readModel(identity)
        const created = after.geoms.find((g) => g.id === resultId)
        if (!created || created.type.toUpperCase() !== type.toUpperCase() || created.parent !== parentId) return unknown()
        return { geometryId: resultId }
      } catch { return unknown() }
    },
    async move(input: MoveGeometryInput, inputIdentity?: ModelIdentity): Promise<{ geometryId: string; origin: [number, number, number] }> {
      checkOpen()
      const identity = snapshotIdentity(inputIdentity)
      let id: string, delta: [number, number, number]
      try {
        if (!input || typeof input !== 'object') return invalid('Invalid move input')
        const geometryId = input.geometryId, frame = input.frame, units = input.units, inputDelta = input.delta
        if (!validId(geometryId) || frame !== 'world' || units !== 'model-native') return invalid('Invalid move input')
        delta = snapshotVector(inputDelta)
        if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return invalid('Invalid move input')
        id = geometryId
      } catch { return invalid('geometryId, world frame, model-native units and a nonzero finite delta are required') }
      const before = await preflight(async () => {
        const model = await readModel(identity)
        const geom = model.geoms.find((g) => g.id === id)
        if (!geom) throw new ModelingError('GEOMETRY_NOT_FOUND', 'Geometry does not exist')
        const origin = await request(() => adapter.geomOrigin(id, ...identityArgs(identity)))
        const snapshot = snapshotVector(origin)
        const expected: [number, number, number] = [snapshot[0] + delta[0], snapshot[1] + delta[1], snapshot[2] + delta[2]]
        for (let i = 0; i < 3; i++) {
          if (!Number.isFinite(expected[i]) || (delta[i] !== 0 && expected[i] === snapshot[i])) invalid('Delta cannot be represented at this origin')
        }
        return { type: geom.type, parent: geom.parent, origin: snapshot, expected }
      })
      checkOpen()
      let result: { ok: boolean }
      let dispatched = false
      try {
        result = await request(() => {
          const method = adapter.moveGeoms
          checkOpen()
          dispatched = true
          return Reflect.apply(method, adapter, [[id], [delta[0], delta[1], delta[2]], ...identityArgs(identity)])
        })
      } catch (e) {
        if (!dispatched && signal.aborted) checkOpen()
        if (dispatched && isNotWrittenStale(e)) return stale()
        return unknown()
      }
      try {
        if (!result || result.ok !== true) return unknown()
        const model = await readModel(identity)
        const geom = model.geoms.find((g) => g.id === id)
        if (!geom || geom.type !== before.type || geom.parent !== before.parent) return unknown()
        const origin = snapshotVector(await request(() => adapter.geomOrigin(id, ...identityArgs(identity))))
        for (let i = 0; i < 3; i++) {
          const n = origin[i]
          const requested = delta[i]
          const roundoff = 4 * Number.EPSILON * Math.abs(before.expected[i])
          if (requested === 0) {
            if (Math.abs(n - before.expected[i]) > 1e-7 + roundoff) return unknown()
            continue
          }
          const represented = Math.abs(before.expected[i] - before.origin[i])
          const tolerance = 1e-7 * Math.abs(requested) + roundoff
          // Coordinate precision must not hide an unverifiable move.
          if (tolerance > 1e-6 * Math.min(Math.abs(requested), represented)) return unknown()
          if (requested > 0 ? n <= before.origin[i] : n >= before.origin[i]) return unknown()
          if (Math.abs(n - before.expected[i]) > tolerance) return unknown()
        }
        return { geometryId: id, origin }
      } catch { return unknown() }
    },
  }
}
