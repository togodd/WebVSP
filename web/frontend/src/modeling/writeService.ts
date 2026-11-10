import type { ModelTree } from '../api/types'
import { ModelingError } from './contracts'

/** Reads must go to the engine, not a UI cache. Writes may have taken effect even if they reject. */
export interface ModelingWriteAdapter {
  model(): Promise<ModelTree>
  geomTypes(): Promise<string[]>
  addGeom(type: string, parentId: string | null): Promise<{ id: string }>
  geomOrigin(id: string): Promise<[number, number, number]>
  moveGeoms(ids: string[], delta: [number, number, number]): Promise<{ ok: boolean }>
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
export function createWriteService(adapter: ModelingWriteAdapter) {
  const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && !id.includes(',')
  const validVector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && Array.from(v).every((x) => typeof x === 'number' && Number.isFinite(x))
  const invalid = (message: string): never => { throw new ModelingError('INVALID_ARGUMENT', message) }
  const unknown = (): never => { throw new ModelingError('OUTCOME_UNKNOWN', 'Write may have taken effect; readback could not verify the outcome. Do not automatically retry.') }
  async function readModel(): Promise<ModelTree> {
    const m = await adapter.model()
    if (!m || !Array.isArray(m.geoms) || m.geoms.some((g) => !g || !validId(g.id) || typeof g.type !== 'string' || !(g.parent === null || validId(g.parent))) || new Set(m.geoms.map((g) => g.id)).size !== m.geoms.length) throw new Error('Invalid model')
    return m
  }
  async function preflight<T>(read: () => Promise<T>): Promise<T> {
    try { return await read() } catch (e) {
      if (e instanceof ModelingError) throw e
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP engine read failed before writing')
    }
  }
  return {
    async create(input: CreateGeometryInput): Promise<{ geometryId: string }> {
      if (!input || typeof input !== 'object' || typeof input.type !== 'string' || !input.type.trim() || !Object.hasOwn(input, 'parentId') || !(input.parentId === null || validId(input.parentId))) invalid('type and explicit parentId are required')
      const { type, parentId } = input
      const before = await preflight(async () => {
        const [model, types] = await Promise.all([readModel(), adapter.geomTypes()])
        if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')) throw new Error('Invalid geometry types')
        if (!types.includes(type)) invalid('Unknown geometry type')
        if (parentId !== null && !model.geoms.some((g) => g.id === parentId)) throw new ModelingError('GEOMETRY_NOT_FOUND', 'Parent geometry does not exist')
        return new Set(model.geoms.map((g) => g.id))
      })
      try {
        const result = await adapter.addGeom(type, parentId)
        if (!result || !validId(result.id) || before.has(result.id)) return unknown()
        const after = await readModel()
        const created = after.geoms.find((g) => g.id === result.id)
        if (!created || created.type !== type || created.parent !== parentId) return unknown()
        return { geometryId: result.id }
      } catch { return unknown() }
    },
    async move(input: MoveGeometryInput): Promise<{ geometryId: string; origin: [number, number, number] }> {
      if (!input || typeof input !== 'object' || !validId(input.geometryId) || input.frame !== 'world' || input.units !== 'model-native' || !validVector(input.delta) || input.delta.every((n) => n === 0)) invalid('geometryId, world frame, model-native units and a nonzero finite delta are required')
      const id = input.geometryId
      const delta: [number, number, number] = [...input.delta]
      const before = await preflight(async () => {
        const model = await readModel()
        const geom = model.geoms.find((g) => g.id === id)
        if (!geom) throw new ModelingError('GEOMETRY_NOT_FOUND', 'Geometry does not exist')
        const origin = await adapter.geomOrigin(id)
        if (!validVector(origin)) throw new Error('Invalid origin')
        const expected = origin.map((n, i) => n + delta[i]) as [number, number, number]
        if (!validVector(expected) || delta.some((n, i) => n !== 0 && expected[i] === origin[i])) invalid('Delta cannot be represented at this origin')
        return { type: geom.type, parent: geom.parent, expected }
      })
      try {
        const result = await adapter.moveGeoms([id], delta)
        if (!result || result.ok !== true) return unknown()
        const model = await readModel()
        const geom = model.geoms.find((g) => g.id === id)
        if (!geom || geom.type !== before.type || geom.parent !== before.parent) return unknown()
        const origin = await adapter.geomOrigin(id)
        if (!validVector(origin) || origin.some((n, i) => Math.abs(n - before.expected[i]) > 1e-7 * Math.max(1, Math.abs(delta[i])) + 4 * Number.EPSILON * Math.abs(before.expected[i]))) return unknown()
        return { geometryId: id, origin: [...origin] }
      } catch { return unknown() }
    },
  }
}
