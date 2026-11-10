import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ api: { model: vi.fn(), bbox: vi.fn() } }))
vi.mock('../api/wasmEngine', () => ({
  getEngineSessionId: () => 'tab',
  discoverModel: vi.fn(),
  callGuarded: vi.fn(async () => ({ modelEpoch: '42', modelEpochValid: true, fileName: '', rev: 1, version: '', geoms: [], active: [] })),
  WasmEngineError: class extends Error {
    readonly code?: string
    constructor(_status: number, message: string, _outcome?: 'not_written' | 'different' | 'unknown', _actual?: number | null, code?: string) { super(message); this.code = code }
  },
}))

import { api } from '../api/client'
import { callGuarded, discoverModel, WasmEngineError } from '../api/wasmEngine'
import { createBrowserModelingService } from './index'

describe('browser modeling identity', () => {
  it('discovers without an epoch, propagates failure, and recovers without legacy model', async () => {
    const discovery = vi.mocked(discoverModel)
    discovery.mockReset()
    discovery.mockRejectedValueOnce(new Error('serializer failure')).mockResolvedValueOnce({ modelEpoch: '42', modelEpochValid: true, fileName: '/home/web_user/test.vsp3', rev: 1, version: '', geoms: [], active: [] })
    const service = createBrowserModelingService()
    try {
      await expect(service.model.getInfo()).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      expect((await service.model.getInfo()).fileName).toBe('test.vsp3')
      expect(discovery).toHaveBeenCalledTimes(2)
      expect(vi.mocked(api.model)).not.toHaveBeenCalled()
    } finally { service.close(); discovery.mockReset() }
  })

  it('rejects an old WASM unknown modelDiscovery operation without legacy fallback', async () => {
    const discovery = vi.mocked(discoverModel), guarded = vi.mocked(callGuarded), legacy = vi.mocked(api.model)
    discovery.mockReset(); guarded.mockClear(); legacy.mockClear()
    discovery.mockRejectedValueOnce(new WasmEngineError(500, 'unknown request: modelDiscovery'))
    const service = createBrowserModelingService()
    try {
      await expect(service.model.getInfo()).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
      expect(discovery).toHaveBeenCalledOnce()
      expect(discovery).toHaveBeenCalledWith(expect.any(AbortSignal))
      expect(legacy).not.toHaveBeenCalled()
      expect(guarded).not.toHaveBeenCalled()
    } finally {
      service.close()
      discovery.mockReset()
    }
  })

  it.each([
    ['Unnamed.vsp3', ''],
    ['/home/web_user/test.vsp3', 'test.vsp3'],
    ['/home/web_user/subdir/test.vsp3', 'subdir/test.vsp3'],
    ['/other/test.vsp3', 'other/test.vsp3'],
    ['relative/test.vsp3', 'relative/test.vsp3'],
    ['', ''],
  ])('presents filename %s as %s for discovery and guarded reads', async (fileName, expected) => {
    const discovery = vi.mocked(discoverModel), guarded = vi.mocked(callGuarded)
    const tree = { modelEpoch: '42', modelEpochValid: true, fileName, rev: 1, version: '', geoms: [], active: [] }
    discovery.mockReset(); guarded.mockReset()
    discovery.mockResolvedValueOnce(tree)
    guarded.mockResolvedValueOnce(tree)
    const service = createBrowserModelingService()
    try {
      const discovered = await service.model.getInfo()
      const scoped = await service.model.getInfo({ sessionId: 'tab', modelEpoch: '42' })
      expect(discovered.fileName).toBe(expected)
      expect(scoped.fileName).toBe(expected)
      expect(scoped).toEqual(discovered)
      expect(discovery).toHaveBeenCalledOnce()
      expect(guarded).toHaveBeenCalledWith('model', '', '', 0, '42', expect.any(AbortSignal))
    } finally {
      service.close()
      discovery.mockReset()
      guarded.mockReset()
      guarded.mockResolvedValue({ modelEpoch: '42', modelEpochValid: true, fileName: '', rev: 1, version: '', geoms: [], active: [] })
    }
  })

  it('passes independent close signals to discovery and guarded reads', async () => {
    const discovery = vi.mocked(discoverModel), guarded = vi.mocked(callGuarded)
    discovery.mockReset(); guarded.mockReset()
    const wait = new Promise<never>(() => {})
    discovery.mockReturnValue(wait); guarded.mockReturnValue(wait)
    const first = createBrowserModelingService(), second = createBrowserModelingService()
    const a = first.model.getInfo(), b = second.model.getInfo({ sessionId: 'tab', modelEpoch: '42' })
    const firstSignal = discovery.mock.calls[0][0]!
    const secondSignal = guarded.mock.calls[0][5]!
    expect(firstSignal).not.toBe(secondSignal)
    first.close()
    await expect(a).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(false)
    second.close()
    await expect(b).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(secondSignal.aborted).toBe(true)
    discovery.mockReset(); guarded.mockReset()
    guarded.mockResolvedValue({ modelEpoch: '42', modelEpochValid: true, fileName: '', rev: 1, version: '', geoms: [], active: [] })
  })

  it('validates and guards with the same values from changing getters', async () => {
    const service = createBrowserModelingService()
    let sessions = 0, epochs = 0
    const token = {
      get sessionId() { return ++sessions === 1 ? 'tab' : 'other' },
      get modelEpoch() { return ++epochs === 1 ? '42' : '43' },
    }
    const pending = service.model.getInfo(token)
    expect(pending).toBeInstanceOf(Promise)
    expect((await pending).identity).toEqual({ sessionId: 'tab', modelEpoch: '42' })
    expect(callGuarded).toHaveBeenCalledWith('model', '', '', 0, '42', expect.any(AbortSignal))
    expect([sessions, epochs]).toEqual([1, 1])
    service.close()
  })

  it('sanitizes identity property access failures on parameter reads', async () => {
    const service = createBrowserModelingService()
    const engine = vi.mocked(callGuarded)
    engine.mockClear()
    const token = { get sessionId(): string { throw new Error('private getter detail') }, modelEpoch: '42' }
    try {
      await expect(service.parameter.listSurfaces('geom', token)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', message: 'A valid model identity is required',
      })
      expect(engine).not.toHaveBeenCalled()
    } finally {
      service.close()
    }
  })

  it('rejects invalid first getter values asynchronously without calling the engine', async () => {
    const service = createBrowserModelingService()
    const token = { get sessionId() { return 'other' }, get modelEpoch() { return '42' } }
    const pending = service.model.getInfo(token)
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toMatchObject({ code: 'STALE_MODEL' })
    service.close()
  })
})

describe('browser facade composite reads', () => {
  const token = { sessionId: 'tab', modelEpoch: '42' }
  const length = { id: 'length', value: 10, type: 0, name: 'Length', group: 'Design', container: 'geom', lowerLimit: 0, upperLimit: 100, active: true }
  const surfaces = [{ id: 'surface', xsecs: ['section'] }]
  const model = (type: string) => ({
    modelEpoch: '42', modelEpochValid: true, fileName: '', rev: 1, version: 'test', active: [],
    geoms: [{ id: 'geom', name: 'Geometry', type, parent: '', children: [], shown: true }],
  })

  it.each([
    { facade: 'wing' as const, type: 'Wing', beforeFailure: [] as string[], failure: 'geomXSecs' },
    { facade: 'fuselage' as const, type: 'Fuselage', beforeFailure: [] as string[], failure: 'fuselageLength' },
    { facade: 'fuselage' as const, type: 'Fuselage', beforeFailure: ['fuselageLength'], failure: 'geomXSecs' },
  ])('$facade.get rejects stale model at $failure without returning a mixed view', async ({ facade, type, beforeFailure, failure }) => {
    const engine = vi.mocked(callGuarded)
    engine.mockReset()
    engine.mockImplementation(async (op) => {
      if (op === 'model') return model(type) as never
      if (op === failure) throw new WasmEngineError(409, 'model replaced', undefined, undefined, 'STALE_MODEL')
      if (op === 'fuselageLength') return length as never
      if (op === 'geomXSecs') return surfaces as never
      throw new Error(`Unexpected operation ${op}`)
    })
    const service = createBrowserModelingService()
    try {
      await expect(service[facade].get('geom', token)).rejects.toMatchObject({ code: 'STALE_MODEL' })
      expect(engine.mock.calls).toEqual([
        ['model', '', '', 0, '42', expect.any(AbortSignal)],
        ...beforeFailure.map((op) => [op, 'geom', '', 0, '42', expect.any(AbortSignal)]),
        [failure, 'geom', '', 0, '42', expect.any(AbortSignal)],
      ])
    } finally {
      service.close()
      engine.mockReset()
    }
  })

  it.each([
    { facade: 'wing' as const, type: 'Wing', operations: ['model', 'geomXSecs'], stalled: 'model' },
    { facade: 'wing' as const, type: 'Wing', operations: ['model', 'geomXSecs'], stalled: 'geomXSecs' },
    { facade: 'fuselage' as const, type: 'Fuselage', operations: ['model', 'fuselageLength', 'geomXSecs'], stalled: 'model' },
    { facade: 'fuselage' as const, type: 'Fuselage', operations: ['model', 'fuselageLength', 'geomXSecs'], stalled: 'fuselageLength' },
    { facade: 'fuselage' as const, type: 'Fuselage', operations: ['model', 'fuselageLength', 'geomXSecs'], stalled: 'geomXSecs' },
  ])('$facade.get closes while $stalled is pending without starting further stages', async ({ facade, type, operations, stalled }) => {
    const engine = vi.mocked(callGuarded)
    engine.mockReset()
    let rejectStalled!: (error: Error) => void
    let stageStarted!: () => void
    const started = new Promise<void>((resolve) => { stageStarted = resolve })
    const pendingStage = new Promise<never>((_resolve, reject) => { rejectStalled = reject })
    engine.mockImplementation(async (op) => {
      if (op === stalled) { stageStarted(); return pendingStage }
      if (op === 'model') return model(type) as never
      if (op === 'fuselageLength') return length as never
      if (op === 'geomXSecs') return surfaces as never
      throw new Error(`Unexpected operation ${op}`)
    })
    const service = createBrowserModelingService()
    try {
      const pending = service[facade].get('geom', token)
      await started
      service.close()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      rejectStalled(new Error('late engine failure'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const expected = operations.slice(0, operations.indexOf(stalled) + 1)
      expect(engine.mock.calls).toEqual(expected.map((op) => [op, op === 'model' ? '' : 'geom', '', 0, '42', expect.any(AbortSignal)]))
    } finally {
      service.close()
      engine.mockReset()
    }
  })

  it.each([
    { facade: 'wing' as const, type: 'Wing', operations: ['model', 'geomXSecs'] },
    { facade: 'fuselage' as const, type: 'Fuselage', operations: ['model', 'fuselageLength', 'geomXSecs'] },
  ])('$facade.get uses one captured epoch for every successful request', async ({ facade, type, operations }) => {
    const engine = vi.mocked(callGuarded)
    engine.mockReset()
    engine.mockImplementation(async (op) => {
      if (op === 'model') return model(type) as never
      if (op === 'fuselageLength') return length as never
      if (op === 'geomXSecs') return surfaces as never
      throw new Error(`Unexpected operation ${op}`)
    })
    const service = createBrowserModelingService()
    let reads = 0
    try {
      const view = await service[facade].get('geom', { sessionId: 'tab', get modelEpoch() { return ++reads === 1 ? '42' : '43' } })
      expect(view.surfaces).toHaveLength(1)
      expect(reads).toBe(1)
      expect(engine.mock.calls).toEqual(operations.map((op) => [op, op === 'model' ? '' : 'geom', '', 0, '42', expect.any(AbortSignal)]))
    } finally {
      service.close()
      engine.mockReset()
    }
  })
})
