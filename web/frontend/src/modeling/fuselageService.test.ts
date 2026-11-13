import { describe, expect, it, vi } from 'vitest'
import { createFuselageService } from './fuselageService'
import { ModelingError } from './contracts'
import type { ModelIdentity } from './contracts'
import type { EngineParameter } from './parameterService'

const length = (): EngineParameter => ({ id: 'p', name: 'Length', group: 'Design', container: 'g', value: 30, type: 0, lowerLimit: 1e-8, upperLimit: 1e12, active: true })
function fixture() {
  const info = { context: { sessionId: 's', engineRevision: 4, engineVersion: 'v' }, geometry: { id: 'g', name: 'Body', type: 'Fuselage', parentId: null, childIds: [], shown: true } }
  const geometry = { get: vi.fn(async (_id: string, _identity?: ModelIdentity) => info) }
  const parameter = {
    getFuselageLength: vi.fn(async (_id: string, _identity?: ModelIdentity): Promise<EngineParameter> => length()),
    listFuselageShapes: vi.fn(async (_id: string, _identity?: ModelIdentity) => [{ id: 'surface0', xsecs: [{ id: 'a', shape: 2 }, { id: 'b', shape: 987 }] }, { id: 'surface1', xsecs: [{ id: 'c', shape: 0 }] }]),
  }
  return { info, geometry, parameter, service: createFuselageService(geometry, parameter) }
}

describe('read-only fuselage service', () => {
  it('reads the actual Design/Length and preserves separate surface and XSec indices', async () => {
    const f = fixture()
    const result = await f.service.get('g')
    expect(result).toEqual({ ...f.info, length: length(), surfaces: [
      { id: 'surface0', index: 0, sections: [{ id: 'a', index: 0, shape: 2 }, { id: 'b', index: 1, shape: 987 }] },
      { id: 'surface1', index: 1, sections: [{ id: 'c', index: 0, shape: 0 }] },
    ] })
    expect(f.parameter.getFuselageLength.mock.calls).toEqual([['g', undefined]])
    expect(f.geometry.get).toHaveBeenCalledWith('g', undefined)
    expect(f.parameter.listFuselageShapes).toHaveBeenCalledWith('g', undefined)
    expect(Object.keys(f.service)).toEqual(['get'])
  })
  it.each(['FUSELAGE', 'Fuselage'])('accepts the exact geometry type %s', async (type) => {
    const f = fixture()
    f.info.geometry.type = type
    const result = await f.service.get('g')
    expect(result.geometry.type).toBe(type)
    expect(result.length).toEqual(length())
    expect(result.surfaces).toHaveLength(2)
  })
  it.each(['fuselage', 'FUSelage', ' FUSELAGE', 'FUSELAGE ', 'Wing', ''])('rejects other geometry types: %s', async (type) => {
    const f = fixture()
    f.info.geometry.type = type
    await expect(f.service.get('g')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(f.parameter.getFuselageLength).not.toHaveBeenCalled()
    expect(f.parameter.listFuselageShapes).not.toHaveBeenCalled()
  })
  it('passes the exact identity to every read without refreshing it', async () => {
    const f = fixture()
    const identity = { sessionId: 's', modelEpoch: 'epoch' }
    await f.service.get('g', identity)
    expect(f.geometry.get.mock.calls[0][1]).toBe(identity)
    expect(f.parameter.getFuselageLength.mock.calls[0][1]).toBe(identity)
    expect(f.parameter.listFuselageShapes.mock.calls[0][1]).toBe(identity)
  })
  it('rejects malformed and undefined shape values while preserving unknown native integers', async () => {
    for (const shape of [-1, NaN, Infinity, 1.5, 2147483648]) {
      const f = fixture()
      f.parameter.listFuselageShapes.mockResolvedValue([{ id: 's', xsecs: [{ id: 'a', shape }] }])
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    const f = fixture()
    f.parameter.listFuselageShapes.mockResolvedValue([{ id: 's', xsecs: [{ id: 'a', shape: -2 }] }])
    expect((await f.service.get('g')).surfaces[0].sections[0].shape).toBe(-2)
  })
  it('allows empty surfaces and empty section lists without inventing data', async () => {
    const f = fixture()
    f.parameter.listFuselageShapes.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 's', xsecs: [] }])
    expect((await f.service.get('g')).surfaces).toEqual([])
    expect((await f.service.get('g')).surfaces).toEqual([{ id: 's', index: 0, sections: [] }])
  })
  it('validates geometry ID, response identity and exact geometry type before reading parameters', async () => {
    const f = fixture()
    await expect(f.service.get('  ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(f.geometry.get).not.toHaveBeenCalled()
    f.info.geometry.id = 'other'
    await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    f.info.geometry.id = 'g'; f.info.geometry.type = 'Wing'
    await expect(f.service.get('g')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(f.parameter.getFuselageLength).not.toHaveBeenCalled()
  })
  it('propagates not found, closed and engine errors from every read stage', async () => {
    for (const stage of ['geometry', 'parameter', 'surfaces'] as const) {
      for (const code of ['GEOMETRY_NOT_FOUND', 'SESSION_CLOSED', 'ENGINE_ERROR'] as const) {
        const f = fixture(), error = new ModelingError(code, 'failure')
        if (stage === 'geometry') f.geometry.get.mockRejectedValue(error)
        if (stage === 'parameter') f.parameter.getFuselageLength.mockRejectedValue(error)
        if (stage === 'surfaces') f.parameter.listFuselageShapes.mockRejectedValue(error)
        await expect(f.service.get('g')).rejects.toBe(error)
      }
    }
  })
  it('rejects invalid parameter ID, name, group or owner', async () => {
    for (const patch of [{ id: '' }, { name: 'Other' }, { group: 'Other' }, { container: '' }, { container: 'other' }]) {
      const f = fixture(); f.parameter.getFuselageLength.mockResolvedValue({ ...length(), ...patch })
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      expect(f.parameter.listFuselageShapes).not.toHaveBeenCalled()
    }
  })
  it('rejects null and non-finite value and limits', async () => {
    for (const field of ['value', 'lowerLimit', 'upperLimit'] as const) {
      for (const value of [null, NaN, Infinity, -Infinity]) {
        const f = fixture(); f.parameter.getFuselageLength.mockResolvedValue({ ...length(), [field]: value })
        await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      }
    }
  })
  it('rejects empty or duplicate surface and section IDs, including across surfaces', async () => {
    for (const surfaces of [
      [{ id: '', xsecs: [] }], [{ id: 's', xsecs: [] }, { id: 's', xsecs: [] }],
      [{ id: 's', xsecs: [{ id: '', shape: 0 }] }], [{ id: 's', xsecs: [{ id: 'a', shape: 0 }, { id: 'a', shape: 0 }] }],
      [{ id: 's', xsecs: [{ id: 'a', shape: 0 }] }, { id: 't', xsecs: [{ id: 'a', shape: 0 }] }],
    ]) {
      const f = fixture(); f.parameter.listFuselageShapes.mockResolvedValue(surfaces)
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('snapshots changing getters before validating and before later reads', async () => {
    const f = fixture()
    let geometryReads = 0, lengthReads = 0, surfaceReads = 0
    const originalGeometry = f.info.geometry
    Object.defineProperty(f.info, 'geometry', { get: () => { geometryReads++; return geometryReads === 1 ? originalGeometry : null } })
    const p = length()
    Object.defineProperty(p, 'value', { enumerable: true, get: () => ++lengthReads === 1 ? 30 : NaN })
    f.parameter.getFuselageLength.mockResolvedValue(p)
    const surface = { get id() { return ++surfaceReads === 1 ? 's' : '' }, xsecs: [{ id: 'a', shape: 0 }] }
    f.parameter.listFuselageShapes.mockResolvedValue([surface])
    const result = await f.service.get('g')
    expect([geometryReads, lengthReads, surfaceReads]).toEqual([1, 1, 1])
    expect(result.length.value).toBe(30)
    expect(result.surfaces[0].id).toBe('s')
  })
  it('captures validated values even if later reads mutate their sources', async () => {
    const f = fixture(), p = length(), childIds: string[] = f.info.geometry.childIds
    f.parameter.getFuselageLength.mockResolvedValue(p)
    f.parameter.listFuselageShapes.mockImplementation(async () => {
      f.info.geometry.id = 'changed'; childIds.push('later'); p.value = NaN
      return []
    })
    const result = await f.service.get('g')
    expect(result.geometry.id).toBe('g')
    expect(result.geometry.childIds).toEqual([])
    expect(result.length.value).toBe(30)
  })
  it('handles non-enumerable validated getters without rereading them', async () => {
    const f = fixture(), p = length()
    let reads = 0
    Object.defineProperty(p, 'value', { enumerable: false, get: () => ++reads === 1 ? 30 : NaN })
    f.parameter.getFuselageLength.mockResolvedValue(p)
    expect((await f.service.get('g')).length.value).toBe(30)
    expect(reads).toBe(1)
  })
  it('rejects sparse arrays and ignores user-defined array iterators', async () => {
    for (const surfaces of [new Array(1), [{ id: 's', xsecs: new Array(1) }]]) {
      const f = fixture(); f.parameter.listFuselageShapes.mockResolvedValue(surfaces)
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    const f = fixture()
    const xsecs = [{ id: 'a', shape: 0 }]; xsecs[Symbol.iterator] = () => { throw new Error('iterator') }
    const surfaces = [{ id: 's', xsecs }]; surfaces[Symbol.iterator] = () => { throw new Error('iterator') }
    f.parameter.listFuselageShapes.mockResolvedValue(surfaces)
    expect((await f.service.get('g')).surfaces[0].sections[0].id).toBe('a')
  })
  it('converts throwing response getters to ENGINE_ERROR but preserves arbitrary dependency rejections', async () => {
    for (const stage of ['geometry', 'length', 'surfaces'] as const) {
      const f = fixture(), error = new Error('hostile')
      if (stage === 'geometry') Object.defineProperty(f.info, 'geometry', { get: () => { throw error } })
      if (stage === 'length') f.parameter.getFuselageLength.mockResolvedValue(Object.defineProperty(length(), 'value', { enumerable: true, get: () => { throw error } }))
      if (stage === 'surfaces') f.parameter.listFuselageShapes.mockResolvedValue([{ get id(): string { throw error }, xsecs: [] }])
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      const g = fixture()
      if (stage === 'geometry') g.geometry.get.mockRejectedValue(error)
      if (stage === 'length') g.parameter.getFuselageLength.mockRejectedValue(error)
      if (stage === 'surfaces') g.parameter.listFuselageShapes.mockRejectedValue(error)
      await expect(g.service.get('g')).rejects.toBe(error)
    }
  })
  it('can combine earlier geometry and length with later shapes without an epoch change', async () => {
    const f = fixture()
    const identity: ModelIdentity = { sessionId: 's', modelEpoch: 'epoch' }
    const oldInfo = { ...f.info, geometry: { ...f.info.geometry, childIds: [...f.info.geometry.childIds] } }
    const oldLength = length()
    let shapes = [{ id: 'surface0', xsecs: [{ id: 'a', shape: 2 }] }]
    let enterShapes!: () => void, releaseShapes!: () => void
    const shapesEntered = new Promise<void>(resolve => { enterShapes = resolve })
    const shapesGate = new Promise<void>(resolve => { releaseShapes = resolve })
    f.parameter.getFuselageLength.mockResolvedValue(oldLength)
    f.parameter.listFuselageShapes.mockImplementation(async () => {
      enterShapes()
      await shapesGate
      return shapes
    })

    // Characterize independent reads with controlled dependencies, not a real GUI edit.
    const pending = f.service.get('g', identity)
    await shapesEntered
    expect(f.geometry.get).toHaveBeenCalledOnce()
    expect(f.parameter.getFuselageLength).toHaveBeenCalledOnce()
    expect(f.parameter.listFuselageShapes).toHaveBeenCalledOnce()
    shapes = [{ id: 'surface0', xsecs: [{ id: 'a', shape: 5 }, { id: 'new', shape: 3 }] }]
    releaseShapes()

    const result = await pending
    expect(identity).toEqual({ sessionId: 's', modelEpoch: 'epoch' })
    expect(f.geometry.get.mock.calls[0][1]).toBe(identity)
    expect(f.parameter.getFuselageLength.mock.calls[0][1]).toBe(identity)
    expect(f.parameter.listFuselageShapes.mock.calls[0][1]).toBe(identity)
    expect(result).toEqual({ ...oldInfo, length: oldLength, surfaces: [
      { id: 'surface0', index: 0, sections: [{ id: 'a', index: 0, shape: 5 }, { id: 'new', index: 1, shape: 3 }] },
    ] })
  })
  it('does not claim atomicity when replacement reuses IDs during asynchronous reads', async () => {
    const f = fixture()
    f.parameter.getFuselageLength.mockImplementation(async () => ({ ...length(), value: 55 }))
    const result = await f.service.get('g')
    expect(result.context.engineRevision).toBe(4)
    expect(result.length.value).toBe(55)
    // Consistent IDs alone cannot prove that the parameter and geometry share a model generation.
  })
})
