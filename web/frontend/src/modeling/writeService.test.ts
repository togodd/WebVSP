import { describe, expect, it, vi } from 'vitest'
import type { ModelTree } from '../api/types'
import { createWriteService } from './writeService'

function fixture() {
  const model: ModelTree = { geoms: [{ id: 'p', name: 'Parent', type: 'Fuselage', parent: null, children: [], shown: true, drawType: 1, color: [0, 0, 1], numXSecSurfs: 1 }], active: [], vehicleId: 'v', fileName: '', version: '3', rev: 1, dirty: false, undo: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } }
  let origin: [number, number, number] = [1, 2, 3]
  const adapter = {
    model: vi.fn(async () => structuredClone(model)),
    geomTypes: vi.fn(async () => ['Fuselage', 'Wing']),
    addGeom: vi.fn(async (type: string, parent: string | null) => { model.geoms.push({ ...model.geoms[0], id: 'new', type, parent }); return { id: 'new' } }),
    geomOrigin: vi.fn(async (_id: string) => [...origin] as [number, number, number]),
    moveGeoms: vi.fn(async (_ids: string[], d: [number, number, number]) => { origin = origin.map((v, i) => v + d[i]) as [number, number, number]; return { ok: true } }),
  }
  return { model, adapter, service: createWriteService(adapter) }
}
const move = { geometryId: 'p', frame: 'world' as const, units: 'model-native' as const, delta: [1, 2, 3] as [number, number, number] }

describe('modeling write service', () => {
  it('checks type and explicit parent and reads back new identity', async () => {
    const { service, adapter } = fixture()
    await expect(service.create({ type: 'Wing', parentId: 'p' })).resolves.toEqual({ geometryId: 'new' })
    expect(adapter.addGeom).toHaveBeenCalledWith('Wing', 'p')
    expect(adapter.model).toHaveBeenCalledTimes(2)
  })
  it('supports explicit root', async () => {
    const { service, adapter } = fixture()
    await expect(service.create({ type: 'Wing', parentId: null })).resolves.toEqual({ geometryId: 'new' })
    expect(adapter.addGeom).toHaveBeenCalledWith('Wing', null)
  })
  it('rejects malformed inputs and missing parents without writing', async () => {
    const { service, adapter } = fixture()
    for (const input of [null, {}, { type: 'Wing' }, { type: 4, parentId: null }, { type: ' ', parentId: null }, { type: 'Bad', parentId: null }, { type: 'Wing', parentId: '' }, { type: 'Wing', parentId: 'a,b' }]) {
      await expect(service.create(input as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(service.create({ type: 'Wing', parentId: 'missing' })).rejects.toMatchObject({ code: 'GEOMETRY_NOT_FOUND' })
    expect(adapter.addGeom).not.toHaveBeenCalled()
  })
  it('rejects an existing or wrong returned ID, type or parent', async () => {
    for (const mode of ['existing', 'missing', 'type', 'parent']) {
      const { service, adapter, model } = fixture()
      adapter.addGeom.mockImplementation(async () => {
        if (mode === 'existing') return { id: 'p' }
        if (mode !== 'missing') model.geoms.push({ ...model.geoms[0], id: 'new', type: mode === 'type' ? 'Fuselage' : 'Wing', parent: mode === 'parent' ? null : 'p' })
        return { id: 'new' }
      })
      await expect(service.create({ type: 'Wing', parentId: 'p' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    }
  })
  it('moves one exact target and verifies world origin', async () => {
    const { service, adapter } = fixture()
    await expect(service.move(move)).resolves.toEqual({ geometryId: 'p', origin: [2, 4, 6] })
    expect(adapter.moveGeoms).toHaveBeenCalledWith(['p'], [1, 2, 3])
  })
  it('requires finite numeric delta, explicit frame and units, and a real target', async () => {
    const { service, adapter } = fixture()
    for (const patch of [{ geometryId: '' }, { geometryId: 'p,x' }, { frame: undefined }, { frame: 'local' }, { units: undefined }, { units: 'mm' }, { delta: [0, 0, 0] }, { delta: [1, 2] }, { delta: [1, 2, NaN] }, { delta: [1, 2, Infinity] }, { delta: [1, 2, '3'] }]) {
      await expect(service.move({ ...move, ...patch } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(service.move({ ...move, geometryId: 'missing' })).rejects.toMatchObject({ code: 'GEOMETRY_NOT_FOUND' })
    expect(adapter.moveGeoms).not.toHaveBeenCalled()
  })
  it('rejects unrepresentable or overflowing expected coordinates before writing', async () => {
    const { service, adapter } = fixture()
    adapter.geomOrigin.mockResolvedValue([1e308, 0, 0])
    await expect(service.move({ ...move, delta: [1, 0, 0] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.move({ ...move, delta: [1e308, 0, 0] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(adapter.moveGeoms).not.toHaveBeenCalled()
  })
  it('does not report success for wrong targets or excessive readback error', async () => {
    const { service, adapter } = fixture()
    adapter.moveGeoms.mockResolvedValue({ ok: true })
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce([2, 4, 6.01])
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('accepts small roundoff but not a replaced target', async () => {
    const { service, adapter, model } = fixture()
    adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce([2 + 1e-8, 4, 6])
    await expect(service.move(move)).resolves.toMatchObject({ geometryId: 'p' })
    adapter.moveGeoms.mockImplementation(async () => { model.geoms[0].type = 'Wing'; return { ok: true } })
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('does not trust explicit engine failure even if coordinates match', async () => {
    const { service, adapter } = fixture()
    adapter.moveGeoms.mockResolvedValue({ ok: false })
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('distinguishes preflight failure from write and readback exceptions', async () => {
    const { service, adapter } = fixture()
    adapter.model.mockRejectedValueOnce(new Error('private'))
    await expect(service.move(move)).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    expect(adapter.moveGeoms).not.toHaveBeenCalled()
    adapter.moveGeoms.mockRejectedValueOnce(new Error('private'))
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    adapter.model.mockResolvedValueOnce(structuredClone(fixture().model)).mockRejectedValueOnce(new Error('private'))
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    adapter.addGeom.mockRejectedValueOnce(new Error('private'))
    await expect(service.create({ type: 'Wing', parentId: null })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
})
