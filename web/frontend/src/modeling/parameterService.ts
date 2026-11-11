import { WasmEngineError } from '../api/wasmEngine'
import { ModelingError, type ModelIdentity } from './contracts'
import { raceClose } from './readService'

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
  surfaces(geometryId: string, identity?: ModelIdentity): Promise<CrossSectionSurface[]>
  fuselageLength(geometryId: string, identity?: ModelIdentity): Promise<EngineParameter>
  list(owner: 'geometry' | 'crossSection', ownerId: string, identity?: ModelIdentity): Promise<string[]>
  get(owner: 'geometry' | 'crossSection', ownerId: string, parameterId: string, identity?: ModelIdentity): Promise<EngineParameter>
}
function id(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ModelingError('INVALID_ARGUMENT', `${field} must be a nonempty string`)
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isId(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function isNumberOrNull(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isFinite(value)) }
function invalid(): never { throw new Error('Invalid parameter response') }
function parameterSnapshot(value: unknown): EngineParameter {
  if (!isRecord(value)) return invalid()
  const { id, value: number, type, name, group, container, lowerLimit, upperLimit, active } = value
  if (!isId(id) || !isNumberOrNull(number) || typeof type !== 'number' || !Number.isInteger(type) ||
      typeof name !== 'string' || typeof group !== 'string' || typeof container !== 'string' ||
      !isNumberOrNull(lowerLimit) || !isNumberOrNull(upperLimit) || typeof active !== 'boolean') return invalid()
  return { id, value: number, type, name, group, container, lowerLimit, upperLimit, active }
}
function arraySnapshot<T>(value: unknown, item: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) return invalid()
  const length = value.length
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) return invalid()
  const result: T[] = []
  for (let i = 0; i < length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return invalid()
    result.push(item(value[i]))
  }
  return result
}
function idsSnapshot(value: unknown): string[] {
  return arraySnapshot(value, item => isId(item) ? item : invalid())
}
function surfacesSnapshot(value: unknown): CrossSectionSurface[] {
  return arraySnapshot(value, surface => {
    if (!isRecord(surface)) return invalid()
    const { id, xsecs } = surface
    if (!isId(id)) return invalid()
    return { id, xsecs: idsSnapshot(xsecs) }
  })
}
export function createParameterService(adapter: ParameterReadAdapter, signal: AbortSignal = new AbortController().signal) {
  function checkOpen() { if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed') }
  function method<K extends keyof ParameterReadAdapter>(key: K): ParameterReadAdapter[K] {
    const fn = adapter[key]
    checkOpen()
    return fn
  }
  async function read<T>(fn: () => Promise<unknown>, snapshot: (result: unknown) => T, owner: 'geometry' | 'crossSection', identity?: ModelIdentity): Promise<T> {
    checkOpen()
    try { const result = await raceClose(signal, fn); checkOpen(); const copy = snapshot(result); checkOpen(); return copy } catch (error) {
      checkOpen()
      if (identity !== undefined && error instanceof WasmEngineError && error.code === 'STALE_MODEL') throw new ModelingError('STALE_MODEL', 'The model identity is stale')
      if (error instanceof WasmEngineError) {
        if (owner === 'geometry' && error.code === 'GEOMETRY_NOT_FOUND') throw new ModelingError('GEOMETRY_NOT_FOUND', 'Geometry not found')
        if (owner === 'crossSection' && error.code === 'CROSS_SECTION_NOT_FOUND') throw new ModelingError('CROSS_SECTION_NOT_FOUND', 'Cross section not found')
      }
      throw new ModelingError('ENGINE_ERROR', 'The OpenVSP parameter request failed')
    }
  }
  return {
    /** Only surfaces and cross sections reachable through the current model's geometry. */
    listSurfaces(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? method('surfaces').call(adapter, owner) : method('surfaces').call(adapter, owner, identity), surfacesSnapshot, 'geometry', identity) },
    /** The engine resolves and checks the unique geometry-owned Design/Length parameter. */
    getFuselageLength(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? method('fuselageLength').call(adapter, owner) : method('fuselageLength').call(adapter, owner, identity), result => { const parameter = parameterSnapshot(result); if (parameter.name !== 'Length' || parameter.group !== 'Design' || parameter.container !== owner) return invalid(); return parameter }, 'geometry', identity) },
    /** IDs returned by OpenVSP's linkable parameter list; not all internal parameters. */
    listGeometryParameterIds(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? method('list').call(adapter, 'geometry', owner) : method('list').call(adapter, 'geometry', owner, identity), idsSnapshot, 'geometry', identity) },
    listCrossSectionParameterIds(sectionId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'); return read(() => identity === undefined ? method('list').call(adapter, 'crossSection', owner) : method('list').call(adapter, 'crossSection', owner, identity), idsSnapshot, 'crossSection', identity) },
    getGeometryParameter(geometryId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? method('get').call(adapter, 'geometry', owner, parm) : method('get').call(adapter, 'geometry', owner, parm, identity), result => { const parameter = parameterSnapshot(result); if (parameter.id !== parm) return invalid(); return parameter }, 'geometry', identity) },
    getCrossSectionParameter(sectionId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? method('get').call(adapter, 'crossSection', owner, parm) : method('get').call(adapter, 'crossSection', owner, parm, identity), result => { const parameter = parameterSnapshot(result); if (parameter.id !== parm) return invalid(); return parameter }, 'crossSection', identity) },
  }
}
