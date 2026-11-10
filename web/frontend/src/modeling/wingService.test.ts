import { describe, expect, it, vi } from 'vitest'
import { createWingService } from './wingService'
import type { WingReadDependencies, WingView } from './wingService'
import { ModelingError } from './contracts'

const context = { sessionId: 'session', engineRevision: 5, engineVersion: 'v' }
function dependencies(): WingReadDependencies {
  return {
    geometry: { get: vi.fn(async (id) => ({ context, geometry: { id, name: 'Wing', type: 'Wing', parentId: null, childIds: [], shown: true } })) },
    parameters: { listSurfaces: vi.fn(async () => [{ id: 'surface', xsecs: ['root', 'section1', 'section2'] }]) },
  }
}

describe('wing read view', () => {
  it('preserves surface and XSec order and marks root separately', async () => {
    const deps = dependencies()
    const result: WingView = await createWingService(deps).get('wing')
    expect(result).toEqual({ geometryId: 'wing', context, surfaces: [{ id: 'surface', stations: [
      { id: 'root', index: 0, kind: 'rootAirfoilStation' },
      { id: 'section1', index: 1, kind: 'wingSection' },
      { id: 'section2', index: 2, kind: 'wingSection' },
    ] }] })
    expect(deps.geometry.get).toHaveBeenCalledWith('wing', undefined)
    expect(deps.parameters.listSurfaces).toHaveBeenCalledWith('wing', undefined)
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
    expect(vi.mocked(deps.parameters.listSurfaces).mock.calls[0][1]).toBe(identity)
  })
  it('accepts empty surface and station lists and restarts indices per surface', async () => {
    const deps = dependencies()
    vi.mocked(deps.parameters.listSurfaces).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'a', xsecs: [] }, { id: 'b', xsecs: ['r'] }, { id: 'c', xsecs: ['s'] }])
    const service = createWingService(deps)
    expect((await service.get('w')).surfaces).toEqual([])
    expect((await service.get('w')).surfaces.map((s) => s.stations)).toEqual([[], [{ id: 'r', index: 0, kind: 'rootAirfoilStation' }], [{ id: 's', index: 0, kind: 'rootAirfoilStation' }]])
  })
  it('rejects invalid ids and non-wing geometry without reading surfaces', async () => {
    const deps = dependencies(), service = createWingService(deps)
    for (const id of ['', ' ', null, 1]) await expect(service.get(id as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    vi.mocked(deps.geometry.get).mockResolvedValueOnce({ context, geometry: { id: 'f', name: 'f', type: 'Fuselage', parentId: null, childIds: [], shown: true } })
    await expect(service.get('f')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(deps.parameters.listSurfaces).not.toHaveBeenCalled()
  })
  it('rejects mismatched geometry IDs and malformed geometry types', async () => {
    const deps = dependencies(), service = createWingService(deps)
    for (const geometry of [null, { id: 'other', type: 'Wing' }, { id: 'w', type: null }, { id: 'w', type: '' }]) {
      vi.mocked(deps.geometry.get).mockResolvedValueOnce({ context, geometry } as never)
      await expect(service.get('w')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    expect(deps.parameters.listSurfaces).not.toHaveBeenCalled()
  })
  it('propagates geometry and parameter errors unchanged', async () => {
    const deps = dependencies(), service = createWingService(deps)
    const missing = new ModelingError('GEOMETRY_NOT_FOUND', 'missing')
    vi.mocked(deps.geometry.get).mockRejectedValueOnce(missing)
    await expect(service.get('w')).rejects.toBe(missing)
    const failure = new ModelingError('ENGINE_ERROR', 'failed')
    vi.mocked(deps.parameters.listSurfaces).mockRejectedValueOnce(failure)
    await expect(service.get('w')).rejects.toBe(failure)
  })
  it('rejects malformed and duplicate surface or station IDs rather than collapsing them', async () => {
    const deps = dependencies(), service = createWingService(deps)
    for (const response of [null, [null], [{ id: '', xsecs: [] }], [{ id: 'a', xsecs: null }], [{ id: 'a', xsecs: [''] }], [{ id: 'a', xsecs: [] }, { id: 'a', xsecs: [] }], [{ id: 'a', xsecs: ['x', 'x'] }], [{ id: 'a', xsecs: ['x'] }, { id: 'b', xsecs: ['x'] }], Array(1), [{ id: 'a', xsecs: Array(1) }]]) {
      vi.mocked(deps.parameters.listSurfaces).mockResolvedValueOnce(response as never)
      await expect(service.get('w')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('performs sequential independent reads and exposes only geometry-read context', async () => {
    const deps = dependencies()
    let release!: (value: Awaited<ReturnType<typeof deps.geometry.get>>) => void
    vi.mocked(deps.geometry.get).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const pending = createWingService(deps).get('w')
    expect(deps.parameters.listSurfaces).not.toHaveBeenCalled()
    release({ context, geometry: { id: 'w', name: 'w', type: 'Wing', parentId: null, childIds: [], shown: true } })
    const result = await pending
    expect(deps.parameters.listSurfaces).toHaveBeenCalledOnce()
    expect(result.context).toEqual(context)
    expect(result.context).not.toBe(context)
  })
})
