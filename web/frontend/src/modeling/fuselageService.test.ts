import { describe, expect, it, vi } from 'vitest'
import { createFuselageService } from './fuselageService'
import { ModelingError } from './contracts'
import type { EngineParameter } from './parameterService'

const length = (): EngineParameter => ({ id: 'p', name: 'Length', group: 'Design', container: 'g', value: 30, type: 0, lowerLimit: 1e-8, upperLimit: 1e12, active: true })
function fixture() {
  const info = { context: { sessionId: 's', engineRevision: 4, engineVersion: 'v' }, geometry: { id: 'g', name: 'Body', type: 'Fuselage', parentId: null, childIds: [], shown: true } }
  const geometry = { get: vi.fn(async (_id: string) => info) }
  const parameter = {
    getFuselageLength: vi.fn(async (_id: string): Promise<EngineParameter> => length()),
    listSurfaces: vi.fn(async (_id: string) => [{ id: 'surface0', xsecs: ['a', 'b'] }, { id: 'surface1', xsecs: ['c'] }]),
  }
  return { info, geometry, parameter, service: createFuselageService(geometry, parameter) }
}

describe('read-only fuselage service', () => {
  it('reads the actual Design/Length and preserves separate surface and XSec indices', async () => {
    const f = fixture()
    const result = await f.service.get('g')
    expect(result).toEqual({ ...f.info, length: length(), surfaces: [
      { id: 'surface0', index: 0, sections: [{ id: 'a', index: 0, shape: null }, { id: 'b', index: 1, shape: null }] },
      { id: 'surface1', index: 1, sections: [{ id: 'c', index: 0, shape: null }] },
    ] })
    expect(f.parameter.getFuselageLength.mock.calls).toEqual([['g']])
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
    expect(f.parameter.getFuselageLength).not.toHaveBeenCalled()
  })
  it('propagates not found, closed and engine errors from every read stage', async () => {
    for (const stage of ['geometry', 'parameter', 'surfaces'] as const) {
      for (const code of ['GEOMETRY_NOT_FOUND', 'SESSION_CLOSED', 'ENGINE_ERROR'] as const) {
        const f = fixture(), error = new ModelingError(code, 'failure')
        if (stage === 'geometry') f.geometry.get.mockRejectedValue(error)
        if (stage === 'parameter') f.parameter.getFuselageLength.mockRejectedValue(error)
        if (stage === 'surfaces') f.parameter.listSurfaces.mockRejectedValue(error)
        await expect(f.service.get('g')).rejects.toBe(error)
      }
    }
  })
  it('rejects invalid parameter ID, name, group or owner', async () => {
    for (const patch of [{ id: '' }, { name: 'Other' }, { group: 'Other' }, { container: '' }, { container: 'other' }]) {
      const f = fixture(); f.parameter.getFuselageLength.mockResolvedValue({ ...length(), ...patch })
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      expect(f.parameter.listSurfaces).not.toHaveBeenCalled()
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
      [{ id: 's', xsecs: [''] }], [{ id: 's', xsecs: ['a', 'a'] }],
      [{ id: 's', xsecs: ['a'] }, { id: 't', xsecs: ['a'] }],
    ]) {
      const f = fixture(); f.parameter.listSurfaces.mockResolvedValue(surfaces)
      await expect(f.service.get('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
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
