import { describe, expect, it, vi } from 'vitest'
import type { ModelTree } from '../api/types'
import { createReadService } from './readService'
import { ModelingError } from './contracts'

function fixture(): ModelTree {
  return { geoms: [{ id: 'f', name: 'Body', type: 'Fuselage', parent: null, children: ['w'], shown: true, drawType: 1, color: [0, 0, 1], numXSecSurfs: 1 }, { id: 'w', name: 'Wing', type: 'Wing', parent: 'f', children: [], shown: false, drawType: 0, color: [0, 0, 1], numXSecSurfs: 1 }], active: ['w'], vehicleId: 'v', fileName: '', version: 'OpenVSP 3.55.0', rev: 7, modelEpoch: '42', modelEpochValid: true, dirty: false, undo: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } }
}

describe('browser-local read service', () => {
  it('reports static geometry.read support even without the optional type adapter', async () => {
    const model = vi.fn(async () => fixture())
    const bbox = vi.fn(async () => null)
    const service = createReadService({ model, bbox }, 'tab')
    const capability = { name: 'geometry.read', status: 'supported' }
    expect(service.capabilities().features.find(c => c.name === 'geometry.read')).toEqual(capability)
    expect(model).not.toHaveBeenCalled()
    expect(bbox).not.toHaveBeenCalled()
    await expect(service.geometry.listTypes()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP engine request failed' })
    expect((await service.geometry.list()).geometries).toHaveLength(2)
    expect(service.capabilities().features.find(c => c.name === 'geometry.read')).toEqual(capability)
  })
  it('calls an optional type adapter with its receiver and maps its failures', async () => {
    const adapter = {
      model: async () => fixture(), bbox: async () => null,
      geomTypes: vi.fn(function (this: unknown) { expect(this).toBe(adapter); return Promise.resolve(['Wing']) }),
    }
    const service = createReadService(adapter, 'tab')
    expect(service.capabilities().features.find(c => c.name === 'geometry.read')).toEqual({ name: 'geometry.read', status: 'supported' })
    await expect(service.geometry.listTypes()).resolves.toEqual(['Wing'])
    expect(adapter.geomTypes).toHaveBeenCalledWith()
    adapter.geomTypes.mockRejectedValueOnce(new Error('private adapter details'))
    await expect(service.geometry.listTypes()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP engine request failed' })
    adapter.geomTypes.mockRejectedValueOnce(new ModelingError('STALE_MODEL', 'private adapter details'))
    await expect(service.geometry.listTypes()).rejects.toMatchObject({ code: 'STALE_MODEL', message: 'The model identity is stale' })
    expect(service.capabilities().features.find(c => c.name === 'geometry.read')?.status).toBe('supported')
  })
  it('validates and copies dense geometry type arrays without using their iterator', async () => {
    const types = ['Wing', '', 'Future']
    types[Symbol.iterator] = () => ['wrong'][Symbol.iterator]()
    const geomTypes = vi.fn(async () => types)
    const service = createReadService({ model: async () => fixture(), bbox: async () => null, geomTypes }, 'tab')
    const result = await service.geometry.listTypes()
    expect(result).toEqual(['Wing', '', 'Future'])
    result[0] = 'changed'
    expect(types[0]).toBe('Wing')
    for (const bad of [null, {}, [1], Array(1), Object.setPrototypeOf(Array(1), Object.assign(Object.create(Array.prototype), { 0: 'inherited' }))]) {
      geomTypes.mockResolvedValueOnce(bad as string[])
      await expect(service.geometry.listTypes()).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('stops reading geometry types when closed and consumes late failures', async () => {
    let reject!: (error: Error) => void
    const geomTypes = vi.fn(() => new Promise<string[]>((_, r) => { reject = r }))
    const service = createReadService({ model: async () => fixture(), bbox: async () => null, geomTypes }, 'tab')
    const pending = service.geometry.listTypes()
    service.close()
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    reject(new Error('late'))
    await expect(service.geometry.listTypes()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(geomTypes).toHaveBeenCalledOnce()

    const later = vi.fn()
    let closing: ReturnType<typeof createReadService>
    const types = ['Wing', 'Fuselage']
    Object.defineProperty(types, '0', { get() { closing.close(); return 'Wing' } })
    Object.defineProperty(types, '1', { get: later })
    closing = createReadService({ model: async () => fixture(), bbox: async () => null, geomTypes: async () => types }, 'tab')
    await expect(closing.geometry.listTypes()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(later).not.toHaveBeenCalled()
  })
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
  it('maps identity getter and proxy failures to invalid arguments without calling the adapter', async () => {
    const model = vi.fn(async () => fixture())
    const service = createReadService({ model, bbox: async () => null }, 'tab')
    for (const token of [
      { get sessionId(): string { throw new Error('private') }, modelEpoch: '42' },
      { sessionId: 'tab', get modelEpoch(): string { throw new ModelingError('STALE_MODEL', 'private') } },
      new Proxy({ sessionId: 'tab', modelEpoch: '42' }, { get() { throw new Error('private') } }),
    ]) {
      await expect(service.model.getInfo(token)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Expected identity is invalid' })
      await expect(service.geometry.get('w', token)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(model).not.toHaveBeenCalled()
  })
  it('prioritizes close when identity getters close the service', async () => {
    for (const throws of [false, true]) {
      const model = vi.fn(async () => fixture())
      const service = createReadService({ model, bbox: async () => null }, 'tab')
      const token = { get sessionId() { service.close(); if (throws) throw new Error('private'); return 'tab' }, modelEpoch: '42' }
      await expect(service.model.getInfo(token)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(service.model.getInfo(token)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(model).not.toHaveBeenCalled()
    }
  })
  it('compares against the original identity even if the adapter mutates its copy', async () => {
    const caller = { sessionId: 'tab', modelEpoch: '42' }
    const model = vi.fn(async (identity?: { sessionId: string; modelEpoch: string }) => {
      expect(identity).not.toBe(caller)
      identity!.sessionId = 'other'; identity!.modelEpoch = '43'
      return { ...fixture(), modelEpoch: '43' }
    })
    const service = createReadService({ model, bbox: async () => null }, 'tab')
    await expect(service.model.getInfo(caller)).rejects.toMatchObject({ code: 'STALE_MODEL' })
    expect(caller).toEqual({ sessionId: 'tab', modelEpoch: '42' })
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
  it('does not invoke adapter methods after their getters close the session', async () => {
    for (const key of ['model', 'bbox'] as const) {
      const method = vi.fn(async () => key === 'model' ? fixture() : null)
      const adapter = { model: async () => fixture(), bbox: async () => null }
      const service = createReadService(adapter, 'tab')
      Object.defineProperty(adapter, key, { get() { service.close(); return method } })
      const pending = key === 'model' ? service.model.getInfo() : service.model.getVisibleSurfaceBounds()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(method).not.toHaveBeenCalled()
    }
  })
  it('stops reading snapshot properties and array entries immediately after close', async () => {
    for (const kind of ['model', 'geometry', 'array', 'bounds'] as const) {
      const model = fixture()
      const bounds = { min: [0, 0, 0], max: [1, 2, 3] }
      const later = vi.fn()
      const service = createReadService({ model: async () => model, bbox: async () => bounds as never }, 'tab')
      if (kind === 'model') {
        Object.defineProperty(model, 'modelEpoch', { get() { service.close(); return '42' } })
        Object.defineProperty(model, 'modelEpochValid', { get: later })
      } else if (kind === 'geometry') {
        Object.defineProperty(model.geoms[0], 'id', { get() { service.close(); return 'f' } })
        Object.defineProperty(model.geoms[0], 'name', { get: later })
      } else if (kind === 'array') {
        Object.defineProperty(model.active, '0', { get() { service.close(); return 'w' } })
        model.active.push('other')
        Object.defineProperty(model.active, '1', { get: later })
      } else {
        Object.defineProperty(bounds, 'min', { get() { service.close(); return [0, 0, 0] } })
        Object.defineProperty(bounds, 'max', { get: later })
      }
      const pending = kind === 'bounds' ? service.model.getVisibleSurfaceBounds() : service.model.getInfo()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(later).not.toHaveBeenCalled()
    }
  })
  it('checks close after identity getters and array proxy descriptor traps', async () => {
    const adapter = { model: vi.fn(async () => fixture()), bbox: async () => null }
    const service = createReadService(adapter, 'tab')
    const later = vi.fn(() => '42')
    await expect(service.model.getInfo({ get sessionId() { service.close(); return 'tab' }, get modelEpoch() { return later() } })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(later).not.toHaveBeenCalled()
    expect(adapter.model).not.toHaveBeenCalled()

    const model = fixture()
    const element = vi.fn(() => 'w')
    let arrayService: ReturnType<typeof createReadService>
    model.active = new Proxy(['w'], {
      getOwnPropertyDescriptor(target, key) { arrayService.close(); return Reflect.getOwnPropertyDescriptor(target, key) },
      get(target, key, receiver) { if (key === '0') return element(); return Reflect.get(target, key, receiver) },
    })
    arrayService = createReadService({ model: async () => model, bbox: async () => null }, 'tab')
    await expect(arrayService.model.getInfo()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(element).not.toHaveBeenCalled()
  })
  it('prioritizes close when adapter or snapshot getters throw', async () => {
    for (const source of ['adapter', 'snapshot'] as const) {
      const model = fixture()
      const adapter = { model: async () => model, bbox: async () => null }
      const service = createReadService(adapter, 'tab')
      Object.defineProperty(source === 'adapter' ? adapter : model, source === 'adapter' ? 'model' : 'modelEpoch', {
        get() { service.close(); throw new ModelingError('STALE_MODEL', 'private') },
      })
      await expect(service.model.getInfo()).rejects.toMatchObject({ code: 'SESSION_CLOSED', message: 'Modeling session is closed' })
    }
  })
  it('safely classifies untrusted adapter rejections and prioritizes reentrant close', async () => {
    for (const behavior of ['prototypeThrow', 'prototypeClose', 'codeThrow', 'codeClose', 'stale'] as const) {
      let service: ReturnType<typeof createReadService>
      const secret = new Error('private classification failure')
      const stale = new ModelingError('STALE_MODEL', 'private backend message')
      const error = behavior.startsWith('prototype')
        ? new Proxy({}, { getPrototypeOf() { if (behavior === 'prototypeClose') service.close(); throw secret } })
        : Object.defineProperty(stale, 'code', { get() {
          if (behavior === 'codeClose') service.close()
          if (behavior === 'codeThrow') throw secret
          return 'STALE_MODEL'
        } })
      service = createReadService({ model: async () => { throw error }, bbox: async () => null }, 'tab')
      const result = await service.model.getInfo().catch(e => e)
      expect(result).toBeInstanceOf(ModelingError)
      expect(result.code).toBe(behavior === 'prototypeClose' || behavior === 'codeClose' ? 'SESSION_CLOSED' : behavior === 'stale' ? 'STALE_MODEL' : 'ENGINE_ERROR')
      expect(result.message).not.toContain('private')
      expect(result).not.toBe(error)
    }
  })
  it('preserves adapter method receivers and error mapping', async () => {
    const adapter = {
      model() { expect(this).toBe(adapter); return Promise.resolve(fixture()) },
      bbox() { expect(this).toBe(adapter); return Promise.resolve(null) },
    }
    const service = createReadService(adapter, 'tab')
    await expect(service.model.getInfo()).resolves.toMatchObject({ identity: { modelEpoch: '42' } })
    await expect(service.model.getVisibleSurfaceBounds()).resolves.toBeNull()
  })
  it('does not return a response after close during a pending request', async () => {
    let resolve!: (m: ModelTree) => void
    const service = createReadService({ model: () => new Promise((r) => { resolve = r }), bbox: async () => null }, 'tab')
    const pending = service.model.getInfo()
    service.close(); resolve(fixture())
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})
