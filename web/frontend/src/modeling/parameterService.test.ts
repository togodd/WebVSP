import { describe, expect, it, vi } from 'vitest'
import { createParameterService } from './index'
import { WasmEngineError } from '../api/wasmEngine'
import { ModelingError } from './contracts'

vi.mock('../api/client', () => ({ api: {} }))
vi.mock('../api/wasmEngine', () => ({
  WasmEngineError: class WasmEngineError extends Error {
    status: number
    outcome?: string
    actual?: number | null
    code?: string
    constructor(status: number, message: string, outcome?: string, actual?: number | null, code?: string) {
      super(message); this.status = status; this.outcome = outcome; this.actual = actual; this.code = code
    }
  },
}))

describe('linkable parameter reads', () => {
  it('does not classify errors thrown while decoding responses as engine rejections', async () => {
    const identity = { sessionId: 'session', modelEpoch: '1' }
    for (const code of ['STALE_MODEL', 'GEOMETRY_NOT_FOUND', 'CROSS_SECTION_NOT_FOUND']) {
      const thrown = new WasmEngineError(404, 'secret', undefined, undefined, code)
      const bad = Object.defineProperty({}, 'id', { get() { throw thrown } })
      const badIds = Object.defineProperty(['p'], '0', { get() { throw thrown } })
      const adapter = { surfaces: async () => [bad] as never, fuselageLength: async () => bad as never, fuselageShapes: async () => [bad] as never, wingShapes: async () => [bad] as never, list: async () => badIds, get: async () => bad as never }
      const service = createParameterService(adapter)
      for (const call of [() => service.listSurfaces('g', identity), () => service.getFuselageLength('g', identity), () => service.getGeometryParameter('g', 'p', identity), () => service.getCrossSectionParameter('x', 'p', identity), () => service.listGeometryParameterIds('g', identity), () => service.listCrossSectionParameterIds('x', identity), () => service.listFuselageShapes('g', identity), () => service.listWingShapes('g', identity)]) {
        await expect(call()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
      }
      const controller = new AbortController()
      const closing = Object.defineProperty({}, 'id', { get() { controller.abort(); throw thrown } })
      const closedService = createParameterService({ ...adapter, surfaces: async () => [closing] as never }, controller.signal)
      await expect(closedService.listSurfaces('g', identity)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    }
  })
  it('routes geometry and cross section owners distinctly', async () => {
    const adapter = { fuselageLength: vi.fn(async () => ({ id: 'parm', value: 1, type: 0, name: 'Length', group: 'Design', container: 'geom', lowerLimit: 0, upperLimit: 10, active: true })), surfaces: vi.fn(async () => [{ id: 'surf', xsecs: ['xs'] }]), list: vi.fn(async () => ['parm']), get: vi.fn(async () => ({ id: 'parm', value: 1, type: 0, name: 'Length', group: 'Design', container: 'geom', lowerLimit: 0, upperLimit: 10, active: true })) }
    const service = createParameterService(adapter)
    expect(await service.listSurfaces('geom')).toEqual([{ id: 'surf', xsecs: ['xs'] }])
    expect(await service.getFuselageLength('geom')).toMatchObject({ id: 'parm', name: 'Length', group: 'Design', container: 'geom' })
    expect(adapter.fuselageLength).toHaveBeenCalledWith('geom')
    await service.listGeometryParameterIds('geom'); await service.listCrossSectionParameterIds('xs')
    await service.getGeometryParameter('geom', 'parm'); await service.getCrossSectionParameter('xs', 'parm')
    expect(adapter.list.mock.calls).toEqual([['geometry', 'geom'], ['crossSection', 'xs']])
    expect(adapter.get.mock.calls).toEqual([['geometry', 'geom', 'parm'], ['crossSection', 'xs', 'parm']])
  })
  it('forwards the exact identity to every read and maps only engine stale errors', async () => {
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    const stale = new WasmEngineError(409, 'secret', undefined, undefined, 'STALE_MODEL')
    const adapter = { surfaces: vi.fn(async () => { throw stale }), fuselageLength: vi.fn(async () => { throw stale }), list: vi.fn(async () => { throw stale }), get: vi.fn(async () => { throw stale }) }
    const service = createParameterService(adapter)
    const calls = [service.listSurfaces('g', identity), service.getFuselageLength('g', identity), service.listGeometryParameterIds('g', identity), service.listCrossSectionParameterIds('x', identity), service.getGeometryParameter('g', 'p', identity), service.getCrossSectionParameter('x', 'p', identity)]
    await Promise.all(calls.map(p => expect(p).rejects.toMatchObject({ code: 'STALE_MODEL' })))
    expect(adapter.surfaces).toHaveBeenCalledWith('g', identity)
    expect(adapter.fuselageLength).toHaveBeenCalledWith('g', identity)
    expect(adapter.list.mock.calls).toEqual([['geometry', 'g', identity], ['crossSection', 'x', identity]])
    expect(adapter.get.mock.calls).toEqual([['geometry', 'g', 'p', identity], ['crossSection', 'x', 'p', identity]])
    expect((adapter.surfaces.mock.calls[0] as unknown as [string, typeof identity])[1]).toBe(identity)
    await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    adapter.surfaces.mockRejectedValue(new Error('secret'))
    await expect(service.listSurfaces('g', identity)).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
  })
  it('maps only matching owner engine errors and never exposes backend data', async () => {
    let failure: unknown
    const reject = async (): Promise<never> => { throw failure }
    const service = createParameterService({ surfaces: reject, fuselageLength: reject, list: reject, get: reject })
    const geometry = [() => service.listSurfaces('secret-id'), () => service.getFuselageLength('secret-id'), () => service.listGeometryParameterIds('secret-id'), () => service.getGeometryParameter('secret-id', 'secret-parm')]
    const sections = [() => service.listCrossSectionParameterIds('secret-id'), () => service.getCrossSectionParameter('secret-id', 'secret-parm')]
    for (const [code, expectedGeometry, expectedSection] of [
      ['GEOMETRY_NOT_FOUND', 'GEOMETRY_NOT_FOUND', 'ENGINE_ERROR'],
      ['CROSS_SECTION_NOT_FOUND', 'ENGINE_ERROR', 'CROSS_SECTION_NOT_FOUND'],
      ['UNKNOWN_SECRET_CODE', 'ENGINE_ERROR', 'ENGINE_ERROR'],
    ] as const) {
      failure = new WasmEngineError(404, 'secret backend message', 'unknown', 123, code)
      for (const [calls, expected] of [[geometry, expectedGeometry], [sections, expectedSection]] as const) for (const call of calls) {
        const error = await call().catch(e => e)
        expect(error).toBeInstanceOf(ModelingError)
        expect(error.toJSON()).toEqual({ code: expected, message: expected === 'GEOMETRY_NOT_FOUND' ? 'Geometry not found' : expected === 'CROSS_SECTION_NOT_FOUND' ? 'Cross section not found' : 'The OpenVSP parameter request failed' })
        expect(JSON.stringify(error)).not.toMatch(/secret|123/i)
      }
    }
    for (const fake of [Object.assign(new Error('secret'), { code: 'GEOMETRY_NOT_FOUND' }), { code: 'CROSS_SECTION_NOT_FOUND', message: 'secret' }, new ModelingError('GEOMETRY_NOT_FOUND', 'secret')]) {
      failure = fake
      for (const call of [...geometry, ...sections]) await expect(call()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
    }
  })
  it('safely classifies hostile rejection values and honors synchronous close', async () => {
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    for (const scenario of ['prototypeThrow', 'prototypeClose', 'prototypeCloseThrow', 'codeThrow', 'codeClose', 'codeCloseThrow', 'codeOnce'] as const) {
      const controller = new AbortController()
      let reads = 0
      const engineError = new WasmEngineError(404, 'secret backend message', undefined, undefined, 'GEOMETRY_NOT_FOUND')
      let failure: unknown
      if (scenario.startsWith('prototype')) {
        failure = new Proxy({}, { getPrototypeOf() {
          reads++
          if (scenario !== 'prototypeThrow') controller.abort()
          if (scenario !== 'prototypeClose') throw new Error('secret trap')
          return null
        } })
      } else {
        Object.defineProperty(engineError, 'code', { get() {
          reads++
          if (scenario === 'codeClose' || scenario === 'codeCloseThrow') controller.abort()
          if (scenario === 'codeThrow' || scenario === 'codeCloseThrow') throw new Error('secret getter')
          if (reads > 1) throw new Error('code read twice')
          return 'GEOMETRY_NOT_FOUND'
        } })
        failure = engineError
      }
      const reject = async (): Promise<never> => { throw failure }
      const service = createParameterService({ surfaces: reject, fuselageLength: reject, list: reject, get: reject }, controller.signal)
      const error = await service.listSurfaces('g', identity).catch(e => e)
      const closed = scenario.includes('Close')
      const code = closed ? 'SESSION_CLOSED' : scenario === 'codeOnce' ? 'GEOMETRY_NOT_FOUND' : 'ENGINE_ERROR'
      expect(error).toBeInstanceOf(ModelingError)
      expect(error.toJSON()).toEqual({ code, message: closed ? 'Modeling session is closed' : code === 'GEOMETRY_NOT_FOUND' ? 'Geometry not found' : 'The OpenVSP parameter request failed' })
      expect(reads, scenario).toBe(1)
    }
  })
  it('prioritizes stale identity and closed session over backend not-found errors', async () => {
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    const stale = new WasmEngineError(409, 'secret', undefined, undefined, 'STALE_MODEL')
    const controller = new AbortController()
    let failure = stale
    const reject = async (): Promise<never> => { throw failure }
    const service = createParameterService({ surfaces: reject, fuselageLength: reject, list: reject, get: reject }, controller.signal)
    await expect(service.listCrossSectionParameterIds('x', identity)).rejects.toMatchObject({ code: 'STALE_MODEL' })
    await expect(service.listCrossSectionParameterIds('x')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    failure = new WasmEngineError(404, 'secret', undefined, undefined, 'CROSS_SECTION_NOT_FOUND')
    const pending = service.listCrossSectionParameterIds('x', identity)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(() => service.listSurfaces('')).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
  })
  it('races every pending parameter read with close and consumes late rejections', async () => {
    const controller = new AbortController()
    const rejects: ((e: Error) => void)[] = []
    const pendingRequest = () => new Promise<never>((_, reject) => { rejects.push(reject) })
    const adapter = { surfaces: vi.fn(pendingRequest), fuselageLength: vi.fn(pendingRequest), list: vi.fn(pendingRequest), get: vi.fn(pendingRequest) }
    const service = createParameterService(adapter, controller.signal)
    const pending = [service.getFuselageLength('g'), service.listSurfaces('g'), service.listGeometryParameterIds('g'), service.listCrossSectionParameterIds('x'), service.getGeometryParameter('g', 'p'), service.getCrossSectionParameter('x', 'p')]
    controller.abort()
    await Promise.all(pending.map((p) => expect(p).rejects.toMatchObject({ code: 'SESSION_CLOSED' })))
    rejects.forEach((reject) => reject(new Error('late')))
    expect(() => service.listSurfaces('')).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
    expect(adapter.surfaces).toHaveBeenCalledTimes(1)
  })
  it('validates all parameter fields, permits null numbers and finite boundaries', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    let response: unknown = parameter
    const service = createParameterService({ surfaces: async () => [], list: async () => [], get: async () => response as typeof parameter, fuselageLength: async () => response as typeof parameter })
    for (const field of ['value', 'lowerLimit', 'upperLimit'] as const) {
      for (const valid of [null, 0, -1, Number.MAX_VALUE]) {
        response = { ...parameter, [field]: valid }
        await expect(service.getGeometryParameter('g', 'p')).resolves.toEqual(response)
      }
      for (const invalid of [undefined, NaN, Infinity, -Infinity, '1', false]) {
        response = { ...parameter, [field]: invalid }
        await expect(service.getGeometryParameter('g', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      }
    }
    const invalidFields: Record<string, unknown[]> = {
      id: ['', ' ', null, 1], type: [null, '0', 0.5, NaN, Infinity],
      name: [null, 1], group: [null, 1], container: [null, 1], active: [null, 0, 'true'],
    }
    for (const [field, values] of Object.entries(invalidFields)) for (const value of values) {
      response = { ...parameter, [field]: value }
      await expect(service.getCrossSectionParameter('x', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    for (const invalid of [null, [], 'parameter', {}]) {
      response = invalid
      await expect(service.getGeometryParameter('g', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    response = { ...parameter, type: -1, name: '', group: '', container: '', active: false }
    await expect(service.getGeometryParameter('g', 'p')).resolves.toEqual(response)
    response = { ...parameter, id: 'other' }
    await expect(service.getGeometryParameter('g', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    await expect(service.getCrossSectionParameter('x', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    response = parameter
    await expect(service.getFuselageLength('g')).resolves.toEqual(parameter)
    for (const [field, value] of [['name', 'length'], ['group', 'Other'], ['container', 'other'], ['id', '']] as const) {
      response = { ...parameter, [field]: value }
      await expect(service.getFuselageLength('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('validates nested surfaces and both parameter ID lists', async () => {
    let response: unknown = []
    const service = createParameterService({ surfaces: async () => response as never, list: async () => response as never, get: async () => { throw new Error() }, fuselageLength: async () => { throw new Error() } })
    for (const valid of [[], [{ id: 's', xsecs: [] }], [{ id: 's', xsecs: ['x', 'y'] }]]) {
      response = valid; await expect(service.listSurfaces('g')).resolves.toEqual(valid)
    }
    for (const invalid of [null, {}, [null], ['s'], [{}], [{ id: '', xsecs: [] }], [{ id: 's', xsecs: null }], [{ id: 's', xsecs: ['x', ' '] }], [{ id: 's', xsecs: [1] }]]) {
      response = invalid; await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    for (const valid of [[], ['a', 'b']]) {
      response = valid
      await expect(service.listGeometryParameterIds('g')).resolves.toEqual(valid)
      await expect(service.listCrossSectionParameterIds('x')).resolves.toEqual(valid)
    }
    for (const invalid of [null, {}, [''], [' '], [1], ['a', null]]) {
      response = invalid
      await expect(service.listGeometryParameterIds('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      await expect(service.listCrossSectionParameterIds('x')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
  })
  it('snapshots each field and array element exactly once before identity checks', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    const counts: Record<string, number> = {}
    const observed = new Proxy(parameter, { get(target, key, receiver) {
      if (typeof key === 'string' && key in target) {
        counts[key] = (counts[key] ?? 0) + 1
        if (counts[key] > 1) throw new Error('field read twice')
      }
      return Reflect.get(target, key, receiver)
    } })
    const idsReads: string[] = []
    const ids = new Proxy(['x'], { get(target, key, receiver) {
      if (key === 'length' || key === '0') idsReads.push(key)
      return Reflect.get(target, key, receiver)
    } })
    let surfaceIdReads = 0, xsecsReads = 0
    const surface = { get id() { surfaceIdReads++; return 's' }, get xsecs() { xsecsReads++; return ids } }
    const service = createParameterService({ surfaces: async () => [surface], list: async () => ids, get: async () => observed, fuselageLength: async () => observed })
    const result = await service.getFuselageLength('g')
    expect(result).toEqual(parameter)
    expect(Object.values(counts)).toEqual(Array(9).fill(1))
    expect(result).not.toBe(parameter)
    const surfaces = await service.listSurfaces('g')
    expect(surfaces).toEqual([{ id: 's', xsecs: ['x'] }])
    expect([surfaceIdReads, xsecsReads]).toEqual([1, 1])
    expect(idsReads).toEqual(['length', '0'])
    idsReads.length = 0
    expect(await service.listGeometryParameterIds('g')).toEqual(['x'])
    expect(idsReads).toEqual(['length', '0'])
  })
  it('rejects sparse arrays and ignores overridden every methods', async () => {
    let response: unknown
    const service = createParameterService({ surfaces: async () => response as never, list: async () => response as never, get: async () => { throw new Error() }, fuselageLength: async () => { throw new Error() } })
    const fakeValid: unknown[] = [null]
    Object.defineProperty(fakeValid, 'every', { value: () => true })
    for (const invalid of [Array(1), fakeValid]) {
      response = invalid
      await expect(service.listGeometryParameterIds('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      await expect(service.listCrossSectionParameterIds('x')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    for (const length of [NaN, -1, 1.5, Infinity, 0x100000000, '0']) {
      response = new Proxy([], { get(target, key, receiver) { return key === 'length' ? length : Reflect.get(target, key, receiver) } })
      await expect(service.listGeometryParameterIds('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    }
    response = [{ id: 's', xsecs: Array(1) }]
    await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    response = [{ id: 's', xsecs: fakeValid }]
    await expect(service.listSurfaces('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    const valid = ['x']
    Object.defineProperty(valid, 'every', { value: () => { throw new Error('must not call every') } })
    response = valid
    await expect(service.listGeometryParameterIds('g')).resolves.toEqual(['x'])
  })
  it('does not leak adapter references and sanitizes throwing getters and proxies', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    const ids = ['x']
    const surfaces = [{ id: 's', xsecs: ids }]
    let response: unknown
    const service = createParameterService({ surfaces: async () => response as never, list: async () => response as never, get: async () => response as never, fuselageLength: async () => response as never })
    response = parameter
    const savedParameter = await service.getGeometryParameter('g', 'p')
    parameter.value = 7
    expect(savedParameter.value).toBe(1)
    response = surfaces
    const savedSurfaces = await service.listSurfaces('g')
    response = ids
    const savedIds = await service.listCrossSectionParameterIds('x')
    surfaces[0].id = 'changed'; ids[0] = 'changed'; surfaces.push({ id: 'extra', xsecs: [] })
    expect(savedSurfaces).toEqual([{ id: 's', xsecs: ['x'] }])
    expect(savedIds).toEqual(['x'])
    response = { ...parameter, get id(): string { throw new Error('secret') } }
    await expect(service.getGeometryParameter('g', 'p')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
    response = new Proxy(['x'], { getOwnPropertyDescriptor() { throw new Error('secret') } })
    await expect(service.listGeometryParameterIds('g')).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
  })
  it('honors close and errors from snapshot getters for every read', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    for (const kind of ['surfaces', 'list', 'get', 'fuselageLength'] as const) for (const behavior of ['close', 'closeThrow', 'throw', 'normal'] as const) {
      const controller = new AbortController()
      let reads = 0
      const getter = <T,>(value: T): T => {
        reads++
        if (behavior === 'close' || behavior === 'closeThrow') controller.abort()
        if (behavior === 'throw' || behavior === 'closeThrow') throw new Error('secret')
        return value
      }
      const response = kind === 'surfaces' ? [{ get id() { return getter('s') }, xsecs: ['x'] }]
        : kind === 'list' ? Object.defineProperty(['p'], '0', { get: () => getter('p') })
          : { ...parameter, get id() { return getter('p') } }
      const adapter = { surfaces: async () => response as never, list: async () => response as never, get: async () => response as never, fuselageLength: async () => response as never }
      const service = createParameterService(adapter, controller.signal)
      const call = kind === 'surfaces' ? () => service.listSurfaces('g') : kind === 'list' ? () => service.listGeometryParameterIds('g') : kind === 'get' ? () => service.getGeometryParameter('g', 'p') : () => service.getFuselageLength('g')
      if (behavior === 'normal') await expect(call()).resolves.toEqual(kind === 'surfaces' ? [{ id: 's', xsecs: ['x'] }] : kind === 'list' ? ['p'] : parameter)
      else await expect(call()).rejects.toMatchObject({ code: behavior === 'throw' ? 'ENGINE_ERROR' : 'SESSION_CLOSED' })
      expect(reads).toBe(1)
    }
  })
  it('checks close after method lookup, preserves receiver and maps getter errors', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    for (const kind of ['surfaces', 'list', 'get', 'fuselageLength'] as const) for (const behavior of ['close', 'closeThrow', 'throw', 'stale', 'notFound', 'normal'] as const) {
      const controller = new AbortController()
      const value = kind === 'surfaces' ? [{ id: 's', xsecs: ['x'] }] : kind === 'list' ? ['p'] : parameter
      const fn = vi.fn(function (this: unknown) { expect(this).toBe(adapter); return Promise.resolve(value) })
      const adapter = { surfaces: async () => [] as never[], list: async () => [] as string[], get: async () => parameter, fuselageLength: async () => parameter }
      let reads = 0
      Object.defineProperty(adapter, kind, { get() {
        reads++
        if (behavior === 'close' || behavior === 'closeThrow') controller.abort()
        if (behavior === 'throw' || behavior === 'closeThrow') throw new Error('secret')
        if (behavior === 'stale') throw new WasmEngineError(409, 'secret', undefined, undefined, 'STALE_MODEL')
        if (behavior === 'notFound') throw new WasmEngineError(404, 'secret', undefined, undefined, 'GEOMETRY_NOT_FOUND')
        return fn
      } })
      const service = createParameterService(adapter, controller.signal)
      const call = kind === 'surfaces' ? () => service.listSurfaces('g', identity) : kind === 'list' ? () => service.listGeometryParameterIds('g', identity) : kind === 'get' ? () => service.getGeometryParameter('g', 'p', identity) : () => service.getFuselageLength('g', identity)
      if (behavior === 'normal') {
        await expect(call()).resolves.toEqual(value)
        expect(fn).toHaveBeenCalledTimes(1)
        expect(fn).toHaveBeenCalledWith(...(kind === 'list' ? ['geometry', 'g', identity] : kind === 'get' ? ['geometry', 'g', 'p', identity] : ['g', identity]))
      } else {
        await expect(call()).rejects.toMatchObject({ code: behavior === 'throw' ? 'ENGINE_ERROR' : behavior === 'stale' ? 'STALE_MODEL' : behavior === 'notFound' ? 'GEOMETRY_NOT_FOUND' : 'SESSION_CLOSED' })
        expect(fn).not.toHaveBeenCalled()
      }
      expect(reads).toBe(1)
    }
  })
  it('stops snapshot reads immediately after synchronous close', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    for (const scenario of ['parameter', 'surface', 'arrayElement', 'arrayLength', 'arrayDescriptor', 'nestedElement'] as const) {
      const controller = new AbortController()
      const later = vi.fn(() => { throw new Error('read after close') })
      let response: unknown
      if (scenario === 'parameter') response = { ...parameter, get id() { controller.abort(); return 'p' }, get value() { return later() } }
      else if (scenario === 'surface') response = [{ get id() { controller.abort(); return 's' }, get xsecs() { return later() } }]
      else if (scenario === 'arrayElement' || scenario === 'nestedElement') {
        const array = ['a', 'b']
        Object.defineProperty(array, '0', { get() { controller.abort(); return 'a' } })
        Object.defineProperty(array, '1', { get: later })
        response = scenario === 'nestedElement' ? [{ id: 's', xsecs: array }, { get id() { return later() }, xsecs: [] }] : array
      } else {
        response = new Proxy(['a'], {
          get(target, key, receiver) {
            if (scenario === 'arrayLength' && key === 'length') controller.abort()
            if (key === '0') later()
            return Reflect.get(target, key, receiver)
          },
          getOwnPropertyDescriptor(target, key) {
            if (scenario === 'arrayDescriptor') controller.abort()
            else later()
            return Reflect.getOwnPropertyDescriptor(target, key)
          },
        })
      }
      const adapter = { surfaces: async () => response as never, list: async () => response as never, get: async () => response as never, fuselageLength: async () => response as never }
      const service = createParameterService(adapter, controller.signal)
      const call = scenario === 'parameter' ? service.getGeometryParameter('g', 'p') : scenario === 'surface' || scenario === 'nestedElement' ? service.listSurfaces('g') : service.listGeometryParameterIds('g')
      await expect(call).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(later, scenario).not.toHaveBeenCalled()
    }
  })
  it('never reads adapter function call property and preserves its receiver', async () => {
    const parameter = { id: 'p', value: 1, type: 0, name: 'Length', group: 'Design', container: 'g', lowerLimit: 0, upperLimit: 10, active: true }
    for (const kind of ['surfaces', 'list', 'get', 'fuselageLength'] as const) {
      const controller = new AbortController()
      const callGetter = vi.fn(() => { controller.abort(); throw new Error('must not access call') })
      const result = kind === 'surfaces' ? [{ id: 's', xsecs: ['x'] }] : kind === 'list' ? ['p'] : parameter
      const fn = vi.fn(function (this: unknown) { expect(this).toBe(adapter); return Promise.resolve(result) })
      Object.defineProperty(fn, 'call', { get: callGetter })
      const adapter = { surfaces: async () => [] as never[], list: async () => [] as string[], get: async () => parameter, fuselageLength: async () => parameter }
      Object.defineProperty(adapter, kind, { value: fn })
      const service = createParameterService(adapter, controller.signal)
      const promise = kind === 'surfaces' ? service.listSurfaces('g') : kind === 'list' ? service.listGeometryParameterIds('g') : kind === 'get' ? service.getGeometryParameter('g', 'p') : service.getFuselageLength('g')
      await expect(promise).resolves.toEqual(result)
      expect(callGetter).not.toHaveBeenCalled()
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })
  describe('shape ID uniqueness', () => {
    const unused = async (): Promise<never> => { throw new Error('unexpected operation') }
    for (const kind of ['fuselage', 'wing'] as const) {
      it(`${kind} rejects duplicate surface and section IDs per response`, async () => {
        let response: unknown = []
        const shapes = async () => response as never
        const service = createParameterService({ surfaces: unused, fuselageLength: unused, list: unused, get: unused, fuselageShapes: shapes, wingShapes: shapes })
        const call = () => kind === 'wing' ? service.listWingShapes('g') : service.listFuselageShapes('g')
        for (const valid of [[], [{ id: 's', xsecs: [] }, { id: 't', xsecs: [] }], [{ id: 's', xsecs: [{ id: 's', shape: 0 }, { id: 'x', shape: 1 }] }, { id: 't', xsecs: [{ id: 'y', shape: 2 }] }]]) {
          response = valid
          await expect(call()).resolves.toEqual(valid)
          await expect(call()).resolves.toEqual(valid)
        }
        for (const invalid of [
          [{ id: 's', xsecs: [] }, { id: 's', xsecs: [] }],
          [{ id: 's', xsecs: [{ id: 'x', shape: 0 }, { id: 'x', shape: 1 }] }],
          [{ id: 's', xsecs: [{ id: 'x', shape: 0 }] }, { id: 't', xsecs: [{ id: 'x', shape: 1 }] }],
        ]) {
          response = invalid
          await expect(call()).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
        }
      })
      it(`${kind} prioritizes close in duplicate ID getters`, async () => {
        for (const field of ['surface', 'section'] as const) for (const throws of [false, true]) {
          const controller = new AbortController()
          const later = vi.fn()
          const duplicate = () => { controller.abort(); if (throws) throw new Error('secret'); return field === 'surface' ? 's' : 'x' }
          const response = field === 'surface'
            ? [{ id: 's', xsecs: [] }, { get id() { return duplicate() }, get xsecs() { return later() } }]
            : [{ id: 's', xsecs: [{ id: 'x', shape: 0 }] }, { id: 't', xsecs: [{ get id() { return duplicate() }, get shape() { return later() } }] }]
          const shapes = async () => response as never
          const service = createParameterService({ surfaces: unused, fuselageLength: unused, list: unused, get: unused, fuselageShapes: shapes, wingShapes: shapes }, controller.signal)
          await expect(kind === 'wing' ? service.listWingShapes('g') : service.listFuselageShapes('g')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
          expect(later).not.toHaveBeenCalled()
        }
      })
    }
  })

  describe('fuselage shape reads', () => {
    const unused = async (): Promise<never> => { throw new Error('unexpected operation') }
    const base = () => ({ surfaces: unused, fuselageLength: unused, list: unused, get: unused })
    const engineError = { code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' }

    it('preserves unknown signed int32 shapes and order in detached snapshots', async () => {
      const response = [{ id: 's', xsecs: [{ id: 'x', shape: -2147483648 }, { id: 'w', shape: -2 }, { id: 'y', shape: 2147483647 }, { id: 'z', shape: 987 }] }, { id: 't', xsecs: [] }]
      const service = createParameterService({ ...base(), fuselageShapes: async () => response })
      const saved = await service.listFuselageShapes('g')
      expect(saved).toEqual(response)
      expect(saved).not.toBe(response)
      expect(saved[0]).not.toBe(response[0])
      expect(saved[0].xsecs).not.toBe(response[0].xsecs)
      expect(saved[0].xsecs[0]).not.toBe(response[0].xsecs[0])
      response[0].xsecs[0].shape = 42; response[0].id = 'changed'; response.push({ id: 'extra', xsecs: [] })
      expect(saved).toEqual([{ id: 's', xsecs: [{ id: 'x', shape: -2147483648 }, { id: 'w', shape: -2 }, { id: 'y', shape: 2147483647 }, { id: 'z', shape: 987 }] }, { id: 't', xsecs: [] }])
    })

    it('rejects invalid shape values and malformed or sparse structures', async () => {
      let response: unknown
      const service = createParameterService({ ...base(), fuselageShapes: async () => response as never })
      for (const shape of [-1, -2147483649, 2147483648, NaN, Infinity, -Infinity, 0.5, '2', null, undefined]) {
        response = [{ id: 's', xsecs: [{ id: 'x', shape }] }]
        await expect(service.listFuselageShapes('g'), String(shape)).rejects.toMatchObject(engineError)
      }
      for (const invalid of [null, {}, Array(1), [null], [[]], [{}], [{ id: ' ', xsecs: [] }], [{ id: 's', xsecs: null }], [{ id: 's', xsecs: Array(1) }], [{ id: 's', xsecs: [null] }], [{ id: 's', xsecs: [[]] }], [{ id: 's', xsecs: [{ id: '', shape: 0 }] }]]) {
        response = invalid
        await expect(service.listFuselageShapes('g')).rejects.toMatchObject(engineError)
      }
      response = []
      await expect(service.listFuselageShapes('g')).resolves.toEqual([])
    })

    it('handles legacy adapters, validates inputs and forwards identity with its receiver', async () => {
      const identity = { sessionId: 'session', modelEpoch: 'epoch' }
      const legacy = createParameterService(base())
      await expect(legacy.listFuselageShapes('g')).rejects.toMatchObject(engineError)
      expect(() => legacy.listFuselageShapes(' ')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
      const fn = vi.fn(function (this: unknown) { expect(this).toBe(adapter); return Promise.resolve([]) })
      const forbiddenCall = vi.fn(() => { throw new Error('secret') })
      Object.defineProperty(fn, 'call', { get: forbiddenCall })
      const adapter = { ...base(), fuselageShapes: fn }
      const service = createParameterService(adapter)
      await service.listFuselageShapes('g'); await service.listFuselageShapes('g', identity)
      expect(fn.mock.calls).toEqual([['g'], ['g', identity]])
      expect((fn.mock.calls[1] as unknown as [string, typeof identity])[1]).toBe(identity)
      expect(forbiddenCall).not.toHaveBeenCalled()
    })

    it('classifies method getters and prioritizes close before invocation', async () => {
      const identity = { sessionId: 'session', modelEpoch: 'epoch' }
      for (const behavior of ['normal', 'throw', 'stale', 'notFound', 'close', 'closeThrow'] as const) {
        const controller = new AbortController()
        const fn = vi.fn(async () => [])
        let reads = 0
        const adapter = { ...base(), get fuselageShapes() {
          reads++
          if (behavior === 'close' || behavior === 'closeThrow') controller.abort()
          if (behavior === 'throw' || behavior === 'closeThrow') throw new Error('secret')
          if (behavior === 'stale' || behavior === 'notFound') throw new WasmEngineError(409, 'secret', undefined, undefined, behavior === 'stale' ? 'STALE_MODEL' : 'GEOMETRY_NOT_FOUND')
          return fn
        } }
        const service = createParameterService(adapter, controller.signal)
        if (behavior === 'normal') await expect(service.listFuselageShapes('g', identity)).resolves.toEqual([])
        else await expect(service.listFuselageShapes('g', identity)).rejects.toMatchObject({ code: behavior === 'stale' ? 'STALE_MODEL' : behavior === 'notFound' ? 'GEOMETRY_NOT_FOUND' : behavior === 'throw' ? 'ENGINE_ERROR' : 'SESSION_CLOSED' })
        expect(reads).toBe(1)
        expect(fn).toHaveBeenCalledTimes(behavior === 'normal' ? 1 : 0)
      }
    })

    it('only maps genuine stale errors when an identity was supplied', async () => {
      const identity = { sessionId: 'session', modelEpoch: 'epoch' }
      let failure: unknown = new WasmEngineError(409, 'secret', undefined, undefined, 'STALE_MODEL')
      const service = createParameterService({ ...base(), fuselageShapes: async () => { throw failure } })
      await expect(service.listFuselageShapes('g', identity)).rejects.toMatchObject({ code: 'STALE_MODEL' })
      await expect(service.listFuselageShapes('g')).rejects.toMatchObject(engineError)
      failure = Object.assign(new Error('secret'), { code: 'STALE_MODEL' })
      await expect(service.listFuselageShapes('g', identity)).rejects.toMatchObject(engineError)
    })

    it('sanitizes hostile nested getters and array proxy traps, with close taking precedence', async () => {
      for (const location of ['surfaceId', 'xsecs', 'sectionId', 'shape', 'outerLength', 'outerDescriptor', 'outerElement', 'innerLength', 'innerDescriptor', 'innerElement'] as const) for (const behavior of ['throw', 'close', 'closeThrow'] as const) {
        const controller = new AbortController()
        let reads = 0
        const trigger = <T,>(value: T): T => {
          reads++
          if (behavior !== 'throw') controller.abort()
          if (behavior !== 'close') throw new Error('secret')
          return value
        }
        const section = { get id() { return location === 'sectionId' ? trigger('x') : 'x' }, get shape() { return location === 'shape' ? trigger(2) : 2 } }
        const wrap = <T,>(array: T[], prefix: 'outer' | 'inner') => new Proxy(array, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver)
            return (location === `${prefix}Length` && key === 'length') || (location === `${prefix}Element` && key === '0') ? trigger(value) : value
          },
          getOwnPropertyDescriptor(target, key) {
            const value = Reflect.getOwnPropertyDescriptor(target, key)
            return location === `${prefix}Descriptor` && key === '0' ? trigger(value) : value
          },
        })
        const inner = wrap([section], 'inner')
        const surface = { get id() { return location === 'surfaceId' ? trigger('s') : 's' }, get xsecs() { return location === 'xsecs' ? trigger(inner) : inner } }
        const response = wrap([surface], 'outer')
        const service = createParameterService({ ...base(), fuselageShapes: async () => response }, controller.signal)
        await expect(service.listFuselageShapes('g'), `${location}/${behavior}`).rejects.toMatchObject(behavior === 'throw' ? engineError : { code: 'SESSION_CLOSED' })
        expect(reads, `${location}/${behavior}`).toBe(1)
      }
    })

    it('reads shape fields once and stops immediately when a getter closes the session', async () => {
      const counts: Record<string, number> = {}
      const once = <T,>(key: string, value: T): T => {
        counts[key] = (counts[key] ?? 0) + 1
        if (counts[key] > 1) throw new Error('read twice')
        return value
      }
      const section = { get id() { return once('sectionId', 'x') }, get shape() { return once('shape', 0) } }
      const surface = { get id() { return once('surfaceId', 's') }, get xsecs() { return once('xsecs', [section]) } }
      const service = createParameterService({ ...base(), fuselageShapes: async () => [surface] })
      await expect(service.listFuselageShapes('g')).resolves.toEqual([{ id: 's', xsecs: [{ id: 'x', shape: 0 }] }])
      expect(counts).toEqual({ surfaceId: 1, xsecs: 1, sectionId: 1, shape: 1 })
      for (const location of ['surfaceId', 'sectionId'] as const) {
        const controller = new AbortController()
        const later = vi.fn(() => { throw new Error('read after close') })
        const response = location === 'surfaceId'
          ? [{ get id() { controller.abort(); return 's' }, get xsecs(): never { return later() } }]
          : [{ id: 's', xsecs: [{ get id() { controller.abort(); return 'x' }, get shape(): never { return later() } }] }]
        const closing = createParameterService({ ...base(), fuselageShapes: async () => response }, controller.signal)
        await expect(closing.listFuselageShapes('g')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
        expect(later).not.toHaveBeenCalled()
      }
    })

    it('rejects revoked proxies and invalid array lengths without leaking details', async () => {
      let response: unknown
      const service = createParameterService({ ...base(), fuselageShapes: async () => response as never })
      const revoked = Proxy.revocable([], {}); revoked.revoke()
      for (const invalid of [revoked.proxy, ...[NaN, -1, 1.5, Infinity, 0x100000000, '0'].map(length => new Proxy([], { get(target, key, receiver) { return key === 'length' ? length : Reflect.get(target, key, receiver) } }))]) {
        response = invalid
        await expect(service.listFuselageShapes('g')).rejects.toMatchObject(engineError)
        response = [{ id: 's', xsecs: invalid }]
        await expect(service.listFuselageShapes('g')).rejects.toMatchObject(engineError)
      }
    })

    it('races pending reads with close and consumes late rejections', async () => {
      const controller = new AbortController()
      let reject!: (error: Error) => void
      const fn = vi.fn(() => new Promise<never>((_, fail) => { reject = fail }))
      const service = createParameterService({ ...base(), fuselageShapes: fn }, controller.signal)
      const pending = service.listFuselageShapes('g')
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      reject(new Error('late secret'))
      expect(() => service.listFuselageShapes('')).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })

  describe('wing shape reads', () => {
    const unused = async (): Promise<never> => { throw new Error('unexpected operation') }
    const base = () => ({ surfaces: unused, fuselageLength: unused, list: unused, get: unused })
    const engineError = { code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' }

    it('preserves unknown signed int32 shapes and order in detached snapshots', async () => {
      const response = [{ id: 's', xsecs: [{ id: 'x', shape: -2147483648 }, { id: 'w', shape: -2 }, { id: 'y', shape: 2147483647 }, { id: 'z', shape: 987 }] }, { id: 't', xsecs: [] }]
      const service = createParameterService({ ...base(), wingShapes: async () => response })
      const saved = await service.listWingShapes('g')
      expect(saved).toEqual(response)
      expect(saved).not.toBe(response)
      expect(saved[0]).not.toBe(response[0])
      expect(saved[0].xsecs).not.toBe(response[0].xsecs)
      expect(saved[0].xsecs[0]).not.toBe(response[0].xsecs[0])
      response[0].xsecs[0].shape = 42; response[0].id = 'changed'; response.push({ id: 'extra', xsecs: [] })
      expect(saved).toEqual([{ id: 's', xsecs: [{ id: 'x', shape: -2147483648 }, { id: 'w', shape: -2 }, { id: 'y', shape: 2147483647 }, { id: 'z', shape: 987 }] }, { id: 't', xsecs: [] }])
    })

    it('rejects invalid shape values and malformed or sparse structures', async () => {
      let response: unknown
      const service = createParameterService({ ...base(), wingShapes: async () => response as never })
      for (const shape of [-1, -2147483649, 2147483648, NaN, Infinity, -Infinity, 0.5, '2', null, undefined]) {
        response = [{ id: 's', xsecs: [{ id: 'x', shape }] }]
        await expect(service.listWingShapes('g'), String(shape)).rejects.toMatchObject(engineError)
      }
      for (const invalid of [null, {}, Array(1), [null], [[]], [{}], [{ id: ' ', xsecs: [] }], [{ id: 's', xsecs: null }], [{ id: 's', xsecs: Array(1) }], [{ id: 's', xsecs: [null] }], [{ id: 's', xsecs: [[]] }], [{ id: 's', xsecs: [{ id: '', shape: 0 }] }]]) {
        response = invalid
        await expect(service.listWingShapes('g')).rejects.toMatchObject(engineError)
      }
      response = []
      await expect(service.listWingShapes('g')).resolves.toEqual([])
    })

    it('handles legacy adapters, validates inputs and forwards identity with its receiver', async () => {
      const identity = { sessionId: 'session', modelEpoch: 'epoch' }
      const legacy = createParameterService(base())
      await expect(legacy.listWingShapes('g')).rejects.toMatchObject(engineError)
      expect(() => legacy.listWingShapes(' ')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
      const fn = vi.fn(function (this: unknown) { expect(this).toBe(adapter); return Promise.resolve([]) })
      const forbiddenCall = vi.fn(() => { throw new Error('secret') })
      Object.defineProperty(fn, 'call', { get: forbiddenCall })
      const adapter = { ...base(), wingShapes: fn }
      const service = createParameterService(adapter)
      await service.listWingShapes('g'); await service.listWingShapes('g', identity)
      expect(fn.mock.calls).toEqual([['g'], ['g', identity]])
      expect((fn.mock.calls[1] as unknown as [string, typeof identity])[1]).toBe(identity)
      expect(forbiddenCall).not.toHaveBeenCalled()
    })

    it('classifies method getters and prioritizes close before invocation', async () => {
      const identity = { sessionId: 'session', modelEpoch: 'epoch' }
      for (const behavior of ['normal', 'throw', 'stale', 'notFound', 'close', 'closeThrow'] as const) {
        const controller = new AbortController()
        const fn = vi.fn(async () => [])
        let reads = 0
        const adapter = { ...base(), get wingShapes() {
          reads++
          if (behavior === 'close' || behavior === 'closeThrow') controller.abort()
          if (behavior === 'throw' || behavior === 'closeThrow') throw new Error('secret')
          if (behavior === 'stale' || behavior === 'notFound') throw new WasmEngineError(409, 'secret', undefined, undefined, behavior === 'stale' ? 'STALE_MODEL' : 'GEOMETRY_NOT_FOUND')
          return fn
        } }
        const service = createParameterService(adapter, controller.signal)
        if (behavior === 'normal') await expect(service.listWingShapes('g', identity)).resolves.toEqual([])
        else await expect(service.listWingShapes('g', identity)).rejects.toMatchObject({ code: behavior === 'stale' ? 'STALE_MODEL' : behavior === 'notFound' ? 'GEOMETRY_NOT_FOUND' : behavior === 'throw' ? 'ENGINE_ERROR' : 'SESSION_CLOSED' })
        expect(reads).toBe(1)
        expect(fn).toHaveBeenCalledTimes(behavior === 'normal' ? 1 : 0)
      }
    })

    it('only maps genuine stale errors when an identity was supplied', async () => {
      const identity = { sessionId: 'session', modelEpoch: 'epoch' }
      let failure: unknown = new WasmEngineError(409, 'secret', undefined, undefined, 'STALE_MODEL')
      const service = createParameterService({ ...base(), wingShapes: async () => { throw failure } })
      await expect(service.listWingShapes('g', identity)).rejects.toMatchObject({ code: 'STALE_MODEL' })
      await expect(service.listWingShapes('g')).rejects.toMatchObject(engineError)
      failure = Object.assign(new Error('secret'), { code: 'STALE_MODEL' })
      await expect(service.listWingShapes('g', identity)).rejects.toMatchObject(engineError)
    })

    it('sanitizes hostile nested getters and array proxy traps, with close taking precedence', async () => {
      for (const location of ['surfaceId', 'xsecs', 'sectionId', 'shape', 'outerLength', 'outerDescriptor', 'outerElement', 'innerLength', 'innerDescriptor', 'innerElement'] as const) for (const behavior of ['throw', 'close', 'closeThrow'] as const) {
        const controller = new AbortController()
        let reads = 0
        const trigger = <T,>(value: T): T => {
          reads++
          if (behavior !== 'throw') controller.abort()
          if (behavior !== 'close') throw new Error('secret')
          return value
        }
        const section = { get id() { return location === 'sectionId' ? trigger('x') : 'x' }, get shape() { return location === 'shape' ? trigger(2) : 2 } }
        const wrap = <T,>(array: T[], prefix: 'outer' | 'inner') => new Proxy(array, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver)
            return (location === `${prefix}Length` && key === 'length') || (location === `${prefix}Element` && key === '0') ? trigger(value) : value
          },
          getOwnPropertyDescriptor(target, key) {
            const value = Reflect.getOwnPropertyDescriptor(target, key)
            return location === `${prefix}Descriptor` && key === '0' ? trigger(value) : value
          },
        })
        const inner = wrap([section], 'inner')
        const surface = { get id() { return location === 'surfaceId' ? trigger('s') : 's' }, get xsecs() { return location === 'xsecs' ? trigger(inner) : inner } }
        const response = wrap([surface], 'outer')
        const service = createParameterService({ ...base(), wingShapes: async () => response }, controller.signal)
        await expect(service.listWingShapes('g'), `${location}/${behavior}`).rejects.toMatchObject(behavior === 'throw' ? engineError : { code: 'SESSION_CLOSED' })
        expect(reads, `${location}/${behavior}`).toBe(1)
      }
    })

    it('reads shape fields once and stops immediately when a getter closes the session', async () => {
      const counts: Record<string, number> = {}
      const once = <T,>(key: string, value: T): T => {
        counts[key] = (counts[key] ?? 0) + 1
        if (counts[key] > 1) throw new Error('read twice')
        return value
      }
      const section = { get id() { return once('sectionId', 'x') }, get shape() { return once('shape', 0) } }
      const surface = { get id() { return once('surfaceId', 's') }, get xsecs() { return once('xsecs', [section]) } }
      const service = createParameterService({ ...base(), wingShapes: async () => [surface] })
      await expect(service.listWingShapes('g')).resolves.toEqual([{ id: 's', xsecs: [{ id: 'x', shape: 0 }] }])
      expect(counts).toEqual({ surfaceId: 1, xsecs: 1, sectionId: 1, shape: 1 })
      for (const location of ['surfaceId', 'sectionId'] as const) {
        const controller = new AbortController()
        const later = vi.fn(() => { throw new Error('read after close') })
        const response = location === 'surfaceId'
          ? [{ get id() { controller.abort(); return 's' }, get xsecs(): never { return later() } }]
          : [{ id: 's', xsecs: [{ get id() { controller.abort(); return 'x' }, get shape(): never { return later() } }] }]
        const closing = createParameterService({ ...base(), wingShapes: async () => response }, controller.signal)
        await expect(closing.listWingShapes('g')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
        expect(later).not.toHaveBeenCalled()
      }
    })

    it('rejects revoked proxies and invalid array lengths without leaking details', async () => {
      let response: unknown
      const service = createParameterService({ ...base(), wingShapes: async () => response as never })
      const revoked = Proxy.revocable([], {}); revoked.revoke()
      for (const invalid of [revoked.proxy, ...[NaN, -1, 1.5, Infinity, 0x100000000, '0'].map(length => new Proxy([], { get(target, key, receiver) { return key === 'length' ? length : Reflect.get(target, key, receiver) } }))]) {
        response = invalid
        await expect(service.listWingShapes('g')).rejects.toMatchObject(engineError)
        response = [{ id: 's', xsecs: invalid }]
        await expect(service.listWingShapes('g')).rejects.toMatchObject(engineError)
      }
    })

    it('races pending reads with close and consumes late rejections', async () => {
      const controller = new AbortController()
      let reject!: (error: Error) => void
      const fn = vi.fn(() => new Promise<never>((_, fail) => { reject = fail }))
      const service = createParameterService({ ...base(), wingShapes: fn }, controller.signal)
      const pending = service.listWingShapes('g')
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      reject(new Error('late secret'))
      expect(() => service.listWingShapes('')).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })


  it('rejects invalid inputs and sanitizes backend errors', async () => {
    const service = createParameterService({ fuselageLength: async () => { throw new Error('secret') }, surfaces: async () => { throw new Error('secret') }, list: async () => [], get: async () => { throw new Error('secret') } })
    expect(() => service.listSurfaces('')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(() => service.getFuselageLength(' ')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    await expect(service.getFuselageLength('geom')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
    expect(() => service.getGeometryParameter('geom', '')).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    await expect(service.listSurfaces('geom')).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'The OpenVSP parameter request failed' })
  })
})
