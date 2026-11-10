import { describe, expect, it, vi } from 'vitest'
import type { ModelTree } from '../api/types'
import { createReadService } from './readService'
import { ModelingError } from './contracts'

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
  it('rejects malformed model projections consistently across read operations', async () => {
    const badModels: unknown[] = [null, {}, ...[
      ['rev', '7'], ['rev', Infinity], ['version', null], ['fileName', 1],
      ['geoms', 'bad'], ['geoms', [null]], ['geoms', Array(1)],
      ['active', 'w'], ['active', [1]], ['active', Array(1)],
    ].map(([key, value]) => ({ ...fixture(), [key as string]: value }))]
    for (const [key, value] of [
      ['id', 1], ['name', null], ['type', 1], ['parent', undefined],
      ['children', 'w'], ['children', [null]], ['children', Array(1)], ['shown', 1],
    ] as const) {
      const model = fixture()
      Object.assign(model.geoms[0], { [key]: value })
      badModels.push(model)
    }
    const throwing = fixture()
    Object.defineProperty(throwing, 'version', { get() { throw new ModelingError('STALE_MODEL', 'private') } })
    badModels.push(throwing)
    for (const bad of badModels) {
      const service = createReadService({ model: async () => bad as ModelTree, bbox: async () => null }, 'tab')
      for (const read of [() => service.model.getInfo(), () => service.model.getSelection(), () => service.geometry.list(), () => service.geometry.get('f')]) {
        await expect(read()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP engine request failed' })
      }
    }
  })
  it('validates array indices instead of trusting a custom iterator or inherited entries', async () => {
    const masked = <T,>(values: T[], replacement: T[]) => {
      values[Symbol.iterator] = () => replacement[Symbol.iterator]()
      return values
    }
    const badModels: ModelTree[] = []
    for (const field of ['active', 'children', 'geoms'] as const) {
      const model = fixture()
      if (field === 'active') model.active = masked(Array(1), ['valid'])
      if (field === 'children') model.geoms[0].children = masked([1] as unknown as string[], ['valid'])
      if (field === 'geoms') model.geoms = masked(Array(1), fixture().geoms)
      badModels.push(model)
    }
    const inherited = Array(1)
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 'inherited' }))
    badModels.push({ ...fixture(), active: inherited })
    for (const model of badModels) {
      const service = createReadService({ model: async () => model, bbox: async () => null }, 'tab')
      await expect(service.model.getInfo()).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    const badBounds = masked([0, NaN, 2], [0, 1, 2]) as [number, number, number]
    const service = createReadService({ model: async () => fixture(), bbox: async () => ({ min: badBounds, max: [1, 2, 3] }) }, 'tab')
    await expect(service.model.getVisibleSurfaceBounds()).rejects.toMatchObject({ code: 'ENGINE_ERROR' })

    const valid = masked(['actual'], ['different'])
    const model = { ...fixture(), active: valid }
    const safe = createReadService({ model: async () => model, bbox: async () => null }, 'tab')
    expect((await safe.model.getSelection()).geometryIds).toEqual(['actual'])
  })
  it('accepts unknown valid strings and copies bounds without extra properties', async () => {
    const model = fixture()
    model.geoms[0].type = 'Future Geometry'; model.geoms[0].name = ''; model.active = ['unknown']
    const bounds = { min: [-2, 0, 10] as [number, number, number], max: [3, 4, 5] as [number, number, number], private: 'secret' }
    const service = createReadService({ model: async () => model, bbox: async () => bounds }, 'tab')
    expect((await service.model.getInfo()).geometries[0]).toMatchObject({ type: 'Future Geometry', name: '' })
    expect((await service.model.getSelection()).geometryIds).toEqual(['unknown'])
    const result = await service.model.getVisibleSurfaceBounds()
    expect(result).toEqual({ min: [-2, 0, 10], max: [3, 4, 5] })
    result!.min[0] = 99
    expect(bounds.min[0]).toBe(-2)
    expect(await createReadService({ model: async () => model, bbox: async () => null }, 'tab').model.getVisibleSurfaceBounds()).toBeNull()
  })
  it('rejects malformed bounds and hides response getter failures', async () => {
    const throwing = { get min() { throw new ModelingError('STALE_MODEL', 'private') }, max: [1, 2, 3] }
    for (const bounds of [undefined, 1, {}, { min: null, max: [1, 2, 3] }, { min: [0, 1], max: [1, 2, 3] }, { min: [0, 1, 2, 3], max: [1, 2, 3] }, { min: [0, NaN, 2], max: [1, 2, 3] }, { min: [0, 1, 2], max: [1, Infinity, 3] }, { min: Array(3), max: [1, 2, 3] }, throwing]) {
      const service = createReadService({ model: async () => fixture(), bbox: async () => bounds as never }, 'tab')
      await expect(service.model.getVisibleSurfaceBounds()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP engine request failed' })
    }
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
