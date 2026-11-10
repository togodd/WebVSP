import { describe, expect, it, vi } from 'vitest'
import type { ModelTree } from '../api/types'
import { createReadService } from './readService'

function fixture(): ModelTree {
  return { geoms: [{ id: 'f', name: 'Body', type: 'Fuselage', parent: null, children: ['w'], shown: true, drawType: 1, color: [0, 0, 1], numXSecSurfs: 1 }, { id: 'w', name: 'Wing', type: 'Wing', parent: 'f', children: [], shown: false, drawType: 0, color: [0, 0, 1], numXSecSurfs: 1 }], active: ['w'], vehicleId: 'v', fileName: '', version: 'OpenVSP 3.55.0', rev: 7, dirty: false, undo: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } }
}

describe('browser-local read service', () => {
  it('returns fresh model information, hierarchy and selection', async () => {
    const current = fixture()
    const adapter = { model: vi.fn(async () => current), bbox: vi.fn(async () => ({ min: [0, 0, 0] as [number, number, number], max: [1, 2, 3] as [number, number, number] })) }
    const service = createReadService(adapter, 'tab-1')
    const first = await service.model.getInfo()
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
