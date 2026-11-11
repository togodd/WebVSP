import { describe, expect, it, vi } from 'vitest'
import { createWingService } from './wingService'
import type { WingReadDependencies, WingView } from './wingService'
import { ModelingError } from './contracts'

const context = { sessionId: 'session', engineRevision: 5, engineVersion: 'v' }
function dependencies(): WingReadDependencies {
  return {
    geometry: { get: vi.fn(async (id) => ({ context, geometry: { id, name: 'Wing', type: 'Wing', parentId: null, childIds: [], shown: true } })) },
    parameters: { listWingShapes: vi.fn(async () => [{ id: 'surface', xsecs: [{ id: 'root', shape: 0 }, { id: 'section1', shape: 2 }, { id: 'section2', shape: 987 }] }]) },
  }
}

describe('wing read view', () => {
  it('preserves surface and XSec order and marks root separately', async () => {
    const deps = dependencies()
    const result: WingView = await createWingService(deps).get('wing')
    expect(result).toEqual({ geometryId: 'wing', context, surfaces: [{ id: 'surface', stations: [
      { id: 'root', index: 0, kind: 'rootAirfoilStation', shape: 0 },
      { id: 'section1', index: 1, kind: 'wingSection', shape: 2 },
      { id: 'section2', index: 2, kind: 'wingSection', shape: 987 },
    ] }] })
    expect(deps.geometry.get).toHaveBeenCalledWith('wing', undefined)
    expect(deps.parameters.listWingShapes).toHaveBeenCalledWith('wing', undefined)
    const verifyReadonly = () => {
      // @ts-expect-error Views are read-only at the type level.
      result.surfaces[0].stations[0].index = 9
    }
    expect(typeof verifyReadonly).toBe('function')
  })
  it('passes the exact identity to every read without refreshing it', async () => {
    const deps = dependencies()
    const identity = { sessionId: 's', modelEpoch: 'epoch' }
    await createWingService(deps).get('wing', identity)
    expect(vi.mocked(deps.geometry.get).mock.calls[0][1]).toBe(identity)
    expect(vi.mocked(deps.parameters.listWingShapes).mock.calls[0][1]).toBe(identity)
  })
  it('accepts empty surface and station lists and restarts indices per surface', async () => {
    const deps = dependencies()
    vi.mocked(deps.parameters.listWingShapes).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'a', xsecs: [] }, { id: 'b', xsecs: [{ id: 'r', shape: 1 }] }, { id: 'c', xsecs: [{ id: 's', shape: -2 }] }])
    const service = createWingService(deps)
    expect((await service.get('w')).surfaces).toEqual([])
    expect((await service.get('w')).surfaces.map((s) => s.stations)).toEqual([[], [{ id: 'r', index: 0, kind: 'rootAirfoilStation', shape: 1 }], [{ id: 's', index: 0, kind: 'rootAirfoilStation', shape: -2 }]])
  })
  it('rejects invalid ids and non-wing geometry without reading surfaces', async () => {
    const deps = dependencies(), service = createWingService(deps)
    for (const id of ['', ' ', null, 1]) await expect(service.get(id as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    vi.mocked(deps.geometry.get).mockResolvedValueOnce({ context, geometry: { id: 'f', name: 'f', type: 'Fuselage', parentId: null, childIds: [], shown: true } })
    await expect(service.get('f')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(deps.parameters.listWingShapes).not.toHaveBeenCalled()
  })
  it('rejects mismatched geometry IDs and malformed geometry types', async () => {
    const deps = dependencies(), service = createWingService(deps)
    for (const geometry of [null, { id: 'other', type: 'Wing' }, { id: 'w', type: null }, { id: 'w', type: '' }]) {
      vi.mocked(deps.geometry.get).mockResolvedValueOnce({ context, geometry } as never)
      await expect(service.get('w')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    expect(deps.parameters.listWingShapes).not.toHaveBeenCalled()
  })
  it('propagates geometry and parameter errors unchanged', async () => {
    const deps = dependencies(), service = createWingService(deps)
    const missing = new ModelingError('GEOMETRY_NOT_FOUND', 'missing')
    vi.mocked(deps.geometry.get).mockRejectedValueOnce(missing)
    await expect(service.get('w')).rejects.toBe(missing)
    const failure = new ModelingError('ENGINE_ERROR', 'failed')
    vi.mocked(deps.parameters.listWingShapes).mockRejectedValueOnce(failure)
    await expect(service.get('w')).rejects.toBe(failure)
    const arbitrary = new TypeError('dependency failure')
    vi.mocked(deps.geometry.get).mockRejectedValueOnce(arbitrary)
    await expect(service.get('w')).rejects.toBe(arbitrary)
    vi.mocked(deps.parameters.listWingShapes).mockRejectedValueOnce(arbitrary)
    await expect(service.get('w')).rejects.toBe(arbitrary)
  })
  it('rejects malformed and duplicate surface or station IDs rather than collapsing them', async () => {
    const deps = dependencies(), service = createWingService(deps)
    for (const response of [null, [null], [{ id: '', xsecs: [] }], [{ id: 'a', xsecs: null }], [{ id: 'a', xsecs: [''] }], [{ id: 'a', xsecs: [] }, { id: 'a', xsecs: [] }], [{ id: 'a', xsecs: [{ id: 'x', shape: 0 }, { id: 'x', shape: 1 }] }], [{ id: 'a', xsecs: [{ id: 'x', shape: 0 }] }, { id: 'b', xsecs: [{ id: 'x', shape: 0 }] }], Array(1), [{ id: 'a', xsecs: Array(1) }]]) {
      vi.mocked(deps.parameters.listWingShapes).mockResolvedValueOnce(response as never)
      await expect(service.get('w')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('validates shape codes while preserving unknown signed int32 values', async () => {
    const deps = dependencies(), service = createWingService(deps)
    for (const shape of [-1, -2147483649, 2147483648, NaN, Infinity, 0.5, null, '2']) {
      vi.mocked(deps.parameters.listWingShapes).mockResolvedValueOnce([{ id: 's', xsecs: [{ id: 'x', shape }] }] as never)
      await expect(service.get('w')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    vi.mocked(deps.parameters.listWingShapes).mockResolvedValueOnce([{ id: 's', xsecs: [{ id: 'x', shape: -2147483648 }, { id: 'y', shape: 2147483647 }] }])
    expect((await service.get('w')).surfaces[0].stations.map(station => station.shape)).toEqual([-2147483648, 2147483647])
  })
  it('snapshots each geometry and context field once before the surface read', async () => {
    const deps = dependencies()
    const once = (value: unknown) => vi.fn().mockReturnValueOnce(value).mockReturnValue(undefined)
    const sessionId = once('s'), engineRevision = once(7), engineVersion = once('v'), id = once('w'), type = once('Wing')
    const source = { get sessionId() { return sessionId() }, get engineRevision() { return engineRevision() }, get engineVersion() { return engineVersion() } }
    const geometry = { get id() { return id() }, get type() { return type() } }
    vi.mocked(deps.geometry.get).mockResolvedValueOnce({ context: source, geometry } as never)
    vi.mocked(deps.parameters.listWingShapes).mockImplementationOnce(async () => { Object.defineProperty(source, 'sessionId', { value: 'changed' }); return [] })
    const result = await createWingService(deps).get('w')
    expect(result.context).toEqual({ sessionId: 's', engineRevision: 7, engineVersion: 'v' })
    for (const getter of [sessionId, engineRevision, engineVersion, id, type]) expect(getter).toHaveBeenCalledOnce()
  })
  it('uses fixed indexed snapshots without consulting array iterators', async () => {
    const deps = dependencies()
    const surfaceId = vi.fn().mockReturnValueOnce('a').mockReturnValue('changed')
    const xsecs = [{ id: 'root', shape: 0 }, { id: 'tip', shape: 3 }]
    xsecs[Symbol.iterator] = () => { throw new Error('iterator') }
    const surface = { get id() { return surfaceId() }, xsecs }
    const surfaces = [surface]
    surfaces[Symbol.iterator] = () => { throw new Error('iterator') }
    vi.mocked(deps.parameters.listWingShapes).mockResolvedValueOnce(surfaces)
    expect((await createWingService(deps).get('w')).surfaces).toEqual([{ id: 'a', stations: [
      { id: 'root', index: 0, kind: 'rootAirfoilStation', shape: 0 }, { id: 'tip', index: 1, kind: 'wingSection', shape: 3 },
    ] }])
    expect(surfaceId).toHaveBeenCalledOnce()
  })
  it('converts hostile response getters and proxy traps into ModelingError', async () => {
    const deps = dependencies(), service = createWingService(deps)
    const boom = () => { throw new TypeError('hostile') }
    for (const response of [null, { get context() { return boom() } }, { context, get geometry() { return boom() } }, { context: { get sessionId() { return boom() } }, geometry: {} }]) {
      vi.mocked(deps.geometry.get).mockResolvedValueOnce(response as never)
      await expect(service.get('w')).rejects.toBeInstanceOf(ModelingError)
    }
    for (const response of [[{ get id() { return boom() }, xsecs: [] }], new Proxy([], { get(target, key) { return key === 'length' ? boom() : Reflect.get(target, key) } }), [{ id: 'a', xsecs: new Proxy([], { getOwnPropertyDescriptor: boom, get(target, key) { return key === 'length' ? 1 : Reflect.get(target, key) } }) }]]) {
      vi.mocked(deps.parameters.listWingShapes).mockResolvedValueOnce(response as never)
      await expect(service.get('w')).rejects.toMatchObject({ name: 'ModelingError', code: 'ENGINE_ERROR' })
    }
  })
  it('rejects inherited entries in sparse arrays', async () => {
    const deps = dependencies(), service = createWingService(deps)
    const sparse = Array(1), stations = Array(1)
    Object.setPrototypeOf(sparse, Object.assign(Object.create(Array.prototype), { 0: { id: 'a', xsecs: [] } }))
    Object.setPrototypeOf(stations, Object.assign(Object.create(Array.prototype), { 0: { id: 'root', shape: 0 } }))
    for (const response of [sparse, [{ id: 'a', xsecs: stations }]]) {
      vi.mocked(deps.parameters.listWingShapes).mockResolvedValueOnce(response)
      await expect(service.get('w')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('performs sequential independent reads and exposes only geometry-read context', async () => {
    const deps = dependencies()
    let release!: (value: Awaited<ReturnType<typeof deps.geometry.get>>) => void
    vi.mocked(deps.geometry.get).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const pending = createWingService(deps).get('w')
    expect(deps.parameters.listWingShapes).not.toHaveBeenCalled()
    release({ context, geometry: { id: 'w', name: 'w', type: 'Wing', parentId: null, childIds: [], shown: true } })
    const result = await pending
    expect(deps.parameters.listWingShapes).toHaveBeenCalledOnce()
    expect(result.context).toEqual(context)
    expect(result.context).not.toBe(context)
  })
})
