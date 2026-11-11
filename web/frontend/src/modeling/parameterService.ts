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
function parameterSnapshot(value: unknown, checkOpen: () => void): EngineParameter {
  if (!isRecord(value)) return invalid()
  const id = value.id; checkOpen()
  const number = value.value; checkOpen()
  const type = value.type; checkOpen()
  const name = value.name; checkOpen()
  const group = value.group; checkOpen()
  const container = value.container; checkOpen()
  const lowerLimit = value.lowerLimit; checkOpen()
  const upperLimit = value.upperLimit; checkOpen()
  const active = value.active; checkOpen()
  if (!isId(id) || !isNumberOrNull(number) || typeof type !== 'number' || !Number.isInteger(type) ||
      typeof name !== 'string' || typeof group !== 'string' || typeof container !== 'string' ||
      !isNumberOrNull(lowerLimit) || !isNumberOrNull(upperLimit) || typeof active !== 'boolean') return invalid()
  return { id, value: number, type, name, group, container, lowerLimit, upperLimit, active }
}
function arraySnapshot<T>(value: unknown, item: (value: unknown) => T, checkOpen: () => void): T[] {
  if (!Array.isArray(value)) return invalid()
  const length = value.length; checkOpen()
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) return invalid()
  const result: T[] = []
  for (let i = 0; i < length; i++) {
    const present = Object.prototype.hasOwnProperty.call(value, i); checkOpen()
    if (!present) return invalid()
    const element = value[i]; checkOpen()
    const copy = item(element); checkOpen()
    result.push(copy)
  }
  return result
}
function idsSnapshot(value: unknown, checkOpen: () => void): string[] {
  return arraySnapshot(value, item => isId(item) ? item : invalid(), checkOpen)
}
function surfacesSnapshot(value: unknown, checkOpen: () => void): CrossSectionSurface[] {
  return arraySnapshot(value, surface => {
    if (!isRecord(surface)) return invalid()
    const id = surface.id; checkOpen()
    const xsecs = surface.xsecs; checkOpen()
    if (!isId(id)) return invalid()
    return { id, xsecs: idsSnapshot(xsecs, checkOpen) }
  }, checkOpen)
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
    listSurfaces(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? Reflect.apply(method('surfaces'), adapter, [owner]) : Reflect.apply(method('surfaces'), adapter, [owner, identity]), result => surfacesSnapshot(result, checkOpen), 'geometry', identity) },
    /** The engine resolves and checks the unique geometry-owned Design/Length parameter. */
    getFuselageLength(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? Reflect.apply(method('fuselageLength'), adapter, [owner]) : Reflect.apply(method('fuselageLength'), adapter, [owner, identity]), result => { const parameter = parameterSnapshot(result, checkOpen); if (parameter.name !== 'Length' || parameter.group !== 'Design' || parameter.container !== owner) return invalid(); return parameter }, 'geometry', identity) },
    /** IDs returned by OpenVSP's linkable parameter list; not all internal parameters. */
    listGeometryParameterIds(geometryId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'); return read(() => identity === undefined ? Reflect.apply(method('list'), adapter, ['geometry', owner]) : Reflect.apply(method('list'), adapter, ['geometry', owner, identity]), result => idsSnapshot(result, checkOpen), 'geometry', identity) },
    listCrossSectionParameterIds(sectionId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'); return read(() => identity === undefined ? Reflect.apply(method('list'), adapter, ['crossSection', owner]) : Reflect.apply(method('list'), adapter, ['crossSection', owner, identity]), result => idsSnapshot(result, checkOpen), 'crossSection', identity) },
    getGeometryParameter(geometryId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(geometryId, 'geometryId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? Reflect.apply(method('get'), adapter, ['geometry', owner, parm]) : Reflect.apply(method('get'), adapter, ['geometry', owner, parm, identity]), result => { const parameter = parameterSnapshot(result, checkOpen); if (parameter.id !== parm) return invalid(); return parameter }, 'geometry', identity) },
    getCrossSectionParameter(sectionId: string, parameterId: string, identity?: ModelIdentity) { checkOpen(); const owner = id(sectionId, 'sectionId'), parm = id(parameterId, 'parameterId'); return read(() => identity === undefined ? Reflect.apply(method('get'), adapter, ['crossSection', owner, parm]) : Reflect.apply(method('get'), adapter, ['crossSection', owner, parm, identity]), result => { const parameter = parameterSnapshot(result, checkOpen); if (parameter.id !== parm) return invalid(); return parameter }, 'crossSection', identity) },
  }
}
