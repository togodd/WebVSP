import { describe, expect, it, vi } from 'vitest'
import { createFuselageService } from './fuselageService'
import { ModelingError } from './contracts'
import type { EngineParameter } from './parameterService'

const length = (): EngineParameter => ({ id: 'p', name: 'Length', group: 'Design', container: 'g', value: 30, type: 0, lowerLimit: 1e-8, upperLimit: 1e12, active: true })
function fixture() {
  const info = { context: { sessionId: 's', engineRevision: 4, engineVersion: 'v' }, geometry: { id: 'g', name: 'Body', type: 'Fuselage', parentId: null, childIds: [], shown: true } }
  const geometry = { get: vi.fn(async (_id: string) => info) }
  const parameter = {
    listGeometryParameterIds: vi.fn(async (_id: string) => ['p']),
    getGeometryParameter: vi.fn(async (_owner: string, _id: string): Promise<EngineParameter> => length()),
    listSurfaces: vi.fn(async (_id: string) => [{ id: 'surface0', xsecs: ['a', 'b'] }, { id: 'surface1', xsecs: ['c'] }]),
  }
  return { info, geometry, parameter, service: createFuselageService(geometry, parameter) }
}

describe('read-only fuselage service', () => {
  it('reads the actual Design/Length and preserves separate surface and XSec indices', async () => {
    const f = fixture()
    f.parameter.listGeometryParameterIds.mockResolvedValue(['other', 'p'])
    f.parameter.getGeometryParameter.mockImplementation(async (_owner, id) => id === 'p' ? length() : { ...length(), id, name: 'Other', container: 'nested' })
    const result = await f.service.get('g')
    expect(result).toEqual({ ...f.info, length: length(), surfaces: [
      { id: 'surface0', index: 0, sections: [{ id: 'a', index: 0, shape: null }, { id: 'b', index: 1, shape: null }] },
      { id: 'surface1', index: 1, sections: [{ id: 'c', index: 0, shape: null }] },
    ] })
    expect(f.parameter.getGeometryParameter.mock.calls).toEqual([['g', 'other'], ['g', 'p']])
    expect(Object.keys(f.service)).toEqual(['get'])
  })
  it('allows empty surfaces and empty section lists without inventing data', async () => {
    const f = fixture()
    f.parameter.listSurfaces.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 's', xsecs: [] }])
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
    expect(f.parameter.listGeometryParameterIds).not.toHaveBeenCalled()
  })
  it('propagates not found, closed and engine errors from every read stage', async () => {
    for (const stage of ['geometry', 'ids', 'parameter', 'surfaces'] as const) {
      for (const code of ['GEOMETRY_NOT_FOUND', 'SESSION_CLOSED', 'ENGINE_ERROR'] as const) {
        const f = fixture(), error = new ModelingError(code, 'failure')
        if (stage === 'geometry') f.geometry.get.mockRejectedValue(error)
        if (stage === 'ids') f.parameter.listGeometryParameterIds.mockRejectedValue(error)
        if (stage === 'parameter') f.parameter.getGeometryParameter.mockRejectedValue(error)
        if (stage === 'surfaces') f.parameter.listSurfaces.mockRejectedValue(error)
        await expect(f.service.get('g')).rejects.toBe(error)
      }
    }
  })
  it('rejects invalid and duplicate parameter IDs, mismatched returned IDs and missing owners', async () => {
    for (const ids of [[''], ['p', 'p']]) {
      const f = fixture(); f.parameter.listGeometryParameterIds.mockResolvedValue(ids)
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      expect(f.parameter.getGeometryParameter).not.toHaveBeenCalled()
    }
    for (const patch of [{ id: 'wrong' }, { container: '' }]) {
      const f = fixture(); f.parameter.getGeometryParameter.mockResolvedValue({ ...length(), ...patch })
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('rejects missing, wrong owner, wrong group and ambiguous Design/Length', async () => {
    for (const patch of [{ name: 'Other' }, { group: 'Other' }, { container: 'other' }]) {
      const f = fixture(); f.parameter.getGeometryParameter.mockResolvedValue({ ...length(), ...patch })
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    const f = fixture(); f.parameter.listGeometryParameterIds.mockResolvedValue(['p', 'q'])
    f.parameter.getGeometryParameter.mockImplementation(async (_owner, id) => ({ ...length(), id }))
    await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    expect(f.parameter.listSurfaces).not.toHaveBeenCalled()
  })
  it('rejects null and non-finite value and limits', async () => {
    for (const field of ['value', 'lowerLimit', 'upperLimit'] as const) {
      for (const value of [null, NaN, Infinity, -Infinity]) {
        const f = fixture(); f.parameter.getGeometryParameter.mockResolvedValue({ ...length(), [field]: value })
        await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      }
    }
  })
  it('rejects empty or duplicate surface and section IDs, including across surfaces', async () => {
    for (const surfaces of [
      [{ id: '', xsecs: [] }], [{ id: 's', xsecs: [] }, { id: 's', xsecs: [] }],
      [{ id: 's', xsecs: [''] }], [{ id: 's', xsecs: ['a', 'a'] }],
      [{ id: 's', xsecs: ['a'] }, { id: 't', xsecs: ['a'] }],
    ]) {
      const f = fixture(); f.parameter.listSurfaces.mockResolvedValue(surfaces)
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('does not claim atomicity when replacement reuses IDs during asynchronous reads', async () => {
    const f = fixture()
    f.parameter.getGeometryParameter.mockImplementation(async () => ({ ...length(), value: 55 }))
    const result = await f.service.get('g')
    expect(result.context.engineRevision).toBe(4)
    expect(result.length.value).toBe(55)
    // Consistent IDs alone cannot prove that the parameter and geometry share a model generation.
  })
})
