import { describe, expect, it, vi } from 'vitest'
import type { ModelTree } from '../api/types'
import { createReadService } from './readService'

function fixture(): ModelTree {
  return { geoms: [{ id: 'f', name: 'Body', type: 'Fuselage', parent: null, children: ['w'], shown: true, drawType: 1, color: [0, 0, 1], numXSecSurfs: 1 }, { id: 'w', name: 'Wing', type: 'Wing', parent: 'f', children: [], shown: false, drawType: 0, color: [0, 0, 1], numXSecSurfs: 1 }], active: ['w'], vehicleId: 'v', fileName: '', version: 'OpenVSP 3.55.0', rev: 7, modelEpoch: '42', modelEpochValid: true, dirty: false, undo: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } }
}

describe('browser-local read service', () => {
  it('returns fresh model information, hierarchy and selection', async () => {
    const current = fixture()
    const adapter = { model: vi.fn(async () => current), bbox: vi.fn(async () => ({ min: [0, 0, 0] as [number, number, number], max: [1, 2, 3] as [number, number, number] })) }
    const service = createReadService(adapter, 'tab-1')
    const first = await service.model.getInfo()
    expect(first.identity).toEqual({ sessionId: 'tab-1', modelEpoch: '42' })
    expect(first.context).toEqual({ sessionId: 'tab-1', engineRevision: 7, engineVersion: 'OpenVSP 3.55.0' })
    expect(first.geometries[0]).toEqual({ id: 'f', name: 'Body', type: 'Fuselage', parentId: null, childIds: ['w'], shown: true })
    expect((await service.geometry.get('w')).geometry.parentId).toBe('f')
    expect((await service.model.getSelection()).geometryIds).toEqual(['w'])
    expect(await service.model.getVisibleSurfaceBounds()).toEqual({ min: [0, 0, 0], max: [1, 2, 3] })
    first.geometries[0].childIds.length = 0
    expect(current.geoms[0].children).toEqual(['w'])
    current.geoms[0].name = 'Updated'; current.rev++
    expect((await service.geometry.list()).geometries[0].name).toBe('Updated')
    expect(adapter.model).toHaveBeenCalledTimes(4)
  })
  it('binds geometry reads to the explicit identity and forwards it to the adapter', async () => {
    const current = fixture()
    const model = vi.fn(async (_expected?: { sessionId: string; modelEpoch: string }) => current)
    const service = createReadService({ model, bbox: async () => null }, 'tab')
    const identity = (await service.model.getInfo()).identity
    expect(model).toHaveBeenCalledTimes(1)
    expect((await service.geometry.get('w', identity)).geometry.id).toBe('w')
    expect(model).toHaveBeenLastCalledWith(identity)
    current.modelEpoch = '43'
    await expect(service.geometry.get('missing', identity)).rejects.toMatchObject({ code: 'STALE_MODEL' })
    const calls = model.mock.calls.length
    await expect(service.geometry.get('w', { sessionId: 'other', modelEpoch: '42' })).rejects.toMatchObject({ code: 'STALE_MODEL' })
    await expect(service.geometry.get('w', { sessionId: 'tab', modelEpoch: '01' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(model).toHaveBeenCalledTimes(calls)
    expect((await service.geometry.get('w')).geometry.id).toBe('w')
  })
  it('reads caller identity getters once and forwards the validated values', async () => {
    const model = vi.fn(async () => fixture())
    const service = createReadService({ model, bbox: async () => null }, 'tab')
    let sessions = 0, epochs = 0
    const token = {
      get sessionId() { return ++sessions === 1 ? 'tab' : 'other' },
      get modelEpoch() { return ++epochs === 1 ? '42' : '43' },
    }
    const pending = service.model.getInfo(token)
    expect(pending).toBeInstanceOf(Promise)
    expect((await pending).identity.modelEpoch).toBe('42')
    expect(model).toHaveBeenCalledWith({ sessionId: 'tab', modelEpoch: '42' })
    expect([sessions, epochs]).toEqual([1, 1])
  })
  it('uses the validated engine epoch when its getter changes', async () => {
    const current = fixture()
    let reads = 0
    Object.defineProperty(current, 'modelEpoch', { get: () => ++reads === 1 ? '42' : 'invalid' })
    const service = createReadService({ model: async () => current, bbox: async () => null }, 'tab')
    expect((await service.model.getInfo({ sessionId: 'tab', modelEpoch: '42' })).identity.modelEpoch).toBe('42')
    expect(reads).toBe(1)
  })
  it('rejects missing, invalid, noncanonical and overflowing snapshot epochs', async () => {
    const current = fixture()
    const model = vi.fn(async () => current)
    const service = createReadService({ model, bbox: async () => null }, 'tab')
    for (const epoch of [undefined, '', '01', '-1', '18446744073709551616']) {
      current.modelEpoch = epoch
      await expect(service.model.getInfo()).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    current.modelEpoch = '18446744073709551615'
    current.modelEpochValid = false
    await expect(service.model.getInfo()).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    current.modelEpochValid = true
    expect((await service.model.getInfo()).identity.modelEpoch).toBe('18446744073709551615')
  })
  it('reports invalid and missing geometry and hides engine errors', async () => {
    const adapter = { model: vi.fn(async () => fixture()), bbox: vi.fn(async () => { throw new Error('internal details') }) }
    const service = createReadService(adapter, 'one')
    await expect(service.geometry.get('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.geometry.get('missing')).rejects.toMatchObject({ code: 'GEOMETRY_NOT_FOUND' })
    await expect(service.model.getVisibleSurfaceBounds()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP engine request failed' })
  })
  it('isolates sessions, capabilities and closing', async () => {
    const adapter = { model: async () => fixture(), bbox: async () => null }
    const a = createReadService(adapter, 'a'), b = createReadService(adapter, 'b')
    expect((await a.model.getInfo()).context.sessionId).toBe('a')
    expect((await b.model.getInfo()).context.sessionId).toBe('b')
    expect(a.capabilities().features.find((c) => c.name === 'parameter.write')?.status).toBe('unsupported')
    a.close()
    await expect(a.model.getInfo()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect((await b.model.getInfo()).context.sessionId).toBe('b')
    expect(() => createReadService(adapter, ' ')).toThrow()
  })
  it('prioritizes closure over invalid arguments and rejected engine requests', async () => {
    let reject!: (error: Error) => void
    const service = createReadService({ model: () => new Promise((_, r) => { reject = r }), bbox: async () => null }, 'tab')
    const pending = service.model.getInfo()
    service.close(); reject(new Error('private'))
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(service.geometry.get('')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
  it('settles hanging model and bounds reads on close and consumes late rejections', async () => {
    let rejectModel!: (error: Error) => void
    let rejectBounds!: (error: Error) => void
    const model = vi.fn(() => new Promise<ModelTree>((_, reject) => { rejectModel = reject }))
    const bbox = vi.fn(() => new Promise<null>((_, reject) => { rejectBounds = reject }))
    const service = createReadService({ model, bbox }, 'tab')
    const pending = [service.model.getInfo(), service.model.getVisibleSurfaceBounds()]
    service.close(); service.close()
    await Promise.all(pending.map((p) => expect(p).rejects.toMatchObject({ code: 'SESSION_CLOSED' })))
    rejectModel(new Error('late')); rejectBounds(new Error('late'))
    await expect(service.model.getInfo()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(model).toHaveBeenCalledTimes(1); expect(bbox).toHaveBeenCalledTimes(1)
  })
  it('does not return a response after close during a pending request', async () => {
    let resolve!: (m: ModelTree) => void
    const service = createReadService({ model: () => new Promise((r) => { resolve = r }), bbox: async () => null }, 'tab')
    const pending = service.model.getInfo()
    service.close(); resolve(fixture())
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})
