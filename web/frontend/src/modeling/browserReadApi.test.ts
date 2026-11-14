import { describe, expect, it, vi } from 'vitest'
vi.mock('./index', () => ({ createBrowserModelingService: vi.fn() }))
import { createBrowserReadApi, installBrowserReadApi } from './browserReadApi'

const methods = {
  model: ['getInfo', 'getSelection', 'getVisibleSurfaceBounds'],
  geometry: ['list', 'listTypes', 'get'],
  parameter: ['listSurfaces', 'getFuselageLength', 'listGeometryParameterIds', 'listCrossSectionParameterIds', 'getGeometryParameter', 'getCrossSectionParameter'],
  wing: ['get', 'getSectionDimensions'],
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
    expect(Object.keys(api).sort()).toEqual(['capabilities', 'declaredCapabilities', 'describeSurface', 'fuselage', 'geometry', 'model', 'parameter', 'protocol', 'wing'])
    for (const [group, names] of Object.entries(methods)) expect(Object.keys((api as any)[group]).sort()).toEqual([...names].sort())
    expect(factory).not.toHaveBeenCalled()
    const target = {} as Window
    installBrowserReadApi(target, factory as never)
    expect(target.__webvspModelingReadV1).toBeDefined()
    expect(factory).not.toHaveBeenCalled()
  })

  it('describes exactly the public surface and its limitations without creating a service', async () => {
    const { api, factory } = fixture()
    const description = await api.describeSurface()
    expect(description.version).toBe(1)
    expect(description.methods.root.slice().sort()).toEqual(Object.keys(api).filter(key => typeof (api as any)[key] === 'function').sort())
    for (const [group, names] of Object.entries(methods)) {
      expect(description.methods[group as keyof typeof methods].slice().sort()).toEqual([...names].sort())
      expect(description.methods[group as keyof typeof methods].slice().sort()).toEqual(Object.keys((api as any)[group]).sort())
    }
    expect(description.limitations).toEqual({
      writesExposed: false,
      generalDispatcherExposed: false,
      engineAvailabilityVerified: false,
      atomicSnapshot: false,
      readsGuaranteedSideEffectFree: false,
      securityBoundary: false,
    })
    expect(factory).not.toHaveBeenCalled()
    description.methods.root.push('fake')
    description.methods.model.length = 0
    description.limitations.securityBoundary = true
    const again = await api.describeSurface()
    expect(again.methods.root).not.toContain('fake')
    expect(again.methods.model).toEqual([...methods.model])
    expect(again.limitations.securityBoundary).toBe(false)
    expect(factory).not.toHaveBeenCalled()
  })

  it('preserves underlying capabilities even when they report write support', async () => {
    const { api, service } = fixture()
    const capabilities = { contractVersion: '1', features: [{ name: 'geometry.create', status: 'supported' }] }
    service.capabilities.mockReturnValueOnce(capabilities)
    expect(await api.capabilities()).toBe(capabilities)
    expect(service.capabilities).toHaveBeenCalledOnce()
    expect(service.close).toHaveBeenCalledOnce()
    expect((await api.describeSurface()).limitations.writesExposed).toBe(false)
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

  it('forwards the identity to listTypes and closes on success and failure', async () => {
    const { api, service, factory } = fixture()
    const identity = { sessionId: 'tab', modelEpoch: '7' }
    const types = ['POD', 'WING']
    const error = Object.assign(new Error('stale model'), { code: 'STALE_MODEL' })
    service.geometry.listTypes.mockResolvedValueOnce(types).mockRejectedValueOnce(error)
    await expect(api.geometry.listTypes(identity)).resolves.toBe(types)
    await expect(api.geometry.listTypes(identity)).rejects.toBe(error)
    expect(service.geometry.listTypes).toHaveBeenCalledTimes(2)
    expect(service.geometry.listTypes).toHaveBeenNthCalledWith(1, identity)
    expect(service.geometry.listTypes).toHaveBeenNthCalledWith(2, identity)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(service.close).toHaveBeenCalledTimes(2)
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
