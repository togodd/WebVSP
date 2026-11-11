import { describe, expect, it, vi } from 'vitest'
vi.mock('./index', () => ({ createBrowserModelingService: vi.fn() }))
import { createBrowserReadApi, installBrowserReadApi } from './browserReadApi'

const methods = {
  model: ['getInfo', 'getSelection', 'getVisibleSurfaceBounds'],
  geometry: ['list', 'get'],
  parameter: ['listSurfaces', 'getFuselageLength', 'listGeometryParameterIds', 'listCrossSectionParameterIds', 'getGeometryParameter', 'getCrossSectionParameter'],
  wing: ['get'],
  fuselage: ['get'],
} as const

function fixture() {
  const service: Record<string, any> = { close: vi.fn(), capabilities: vi.fn(), protocol: vi.fn(), declaredCapabilities: vi.fn(), write: { create: vi.fn() } }
  for (const [group, names] of Object.entries(methods)) {
    service[group] = Object.fromEntries(names.map(name => [name, vi.fn()]))
  }
  service.parameter.set = vi.fn()
  const factory = vi.fn(() => service)
  return { service, factory, api: createBrowserReadApi(factory as never) }
}

describe('versioned browser read API', () => {
  it('exposes exactly the whitelist and does not create a service on construction or installation', () => {
    const { api, factory } = fixture()
    expect(Object.keys(api).sort()).toEqual(['capabilities', 'declaredCapabilities', 'fuselage', 'geometry', 'model', 'parameter', 'protocol', 'wing'])
    for (const [group, names] of Object.entries(methods)) expect(Object.keys((api as any)[group]).sort()).toEqual([...names].sort())
    expect(factory).not.toHaveBeenCalled()
    const target = {} as Window
    installBrowserReadApi(target, factory as never)
    expect(target.__webvspModelingReadV1).toBeDefined()
    expect(factory).not.toHaveBeenCalled()
  })

  it('forwards all arguments and return values, creating and closing a service per call', async () => {
    const { api, factory, service } = fixture()
    const args = ['geom', 'parm', { sessionId: 'tab', modelEpoch: '7' }]
    const value = { result: true }
    const paths = [...Object.entries(methods).flatMap(([group, names]) => names.map(name => [group, name])), ['', 'capabilities'], ['', 'protocol'], ['', 'declaredCapabilities']]
    for (const [group, name] of paths) {
      const fn = group ? service[group][name] : service[name]
      fn.mockResolvedValueOnce(value)
      const wrapper = group ? (api as any)[group][name] : (api as any)[name]
      const forwarded = group ? args : []
      expect(await wrapper(...forwarded)).toBe(value)
      expect(fn).toHaveBeenCalledWith(...forwarded)
    }
    expect(factory).toHaveBeenCalledTimes(paths.length)
    expect(service.close).toHaveBeenCalledTimes(paths.length)
  })

  it('closes after async rejection or synchronous throw, preserving the error', async () => {
    const { api, service, factory } = fixture()
    const error = new Error('read failed')
    service.model.getInfo.mockRejectedValueOnce(error).mockImplementationOnce(() => { throw error })
    await expect(api.model.getInfo()).rejects.toBe(error)
    await expect(api.model.getInfo()).rejects.toBe(error)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(service.close).toHaveBeenCalledTimes(2)
  })

  it('keeps concurrent calls independent and closes only when each settles', async () => {
    const { api, service, factory } = fixture()
    let resolve!: (value: unknown) => void
    service.model.getInfo.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce('second')
    const first = api.model.getInfo()
    expect(service.close).not.toHaveBeenCalled()
    await expect(api.model.getInfo()).resolves.toBe('second')
    expect(service.close).toHaveBeenCalledTimes(1)
    resolve('first')
    await expect(first).resolves.toBe('first')
    expect(factory).toHaveBeenCalledTimes(2)
    expect(service.close).toHaveBeenCalledTimes(2)
  })
})
