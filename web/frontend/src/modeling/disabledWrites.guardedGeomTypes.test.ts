import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ api: { bbox: vi.fn() } }))
vi.mock('../api/wasmEngine', async (importOriginal) => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  const actual = await importOriginal<typeof import('../api/wasmEngine')>()
  vi.unstubAllGlobals()
  return { ...actual, getEngineSessionId: () => 'tab', callGuarded: vi.fn(), discoverModel: vi.fn(), discoverModelingProtocol: vi.fn() }
})

import { callGuarded, WasmEngineError } from '../api/wasmEngine'
import { createBrowserModelingService } from './index'

const token = { sessionId: 'tab', modelEpoch: '42' }
const tree = (geoms: { id: string; type: string; parent: string | null }[]) => ({ geoms })
const geom = { id: 'g', type: 'WING', parent: null }

describe('guarded facade writes', () => {
  it('advertises writes independently from protocol discovery', () => {
    const service = createBrowserModelingService()
    for (const name of ['parameter.write', 'geometry.create', 'geometry.move']) {
      expect(service.capabilities().features.find(c => c.name === name)).toEqual({ name, status: 'supported' })
    }
    service.close()
  })

  it('creates and verifies using one captured epoch on all guarded calls', async () => {
    const engine = vi.mocked(callGuarded)
    engine.mockReset().mockImplementation(async op => {
      if (op === 'geomTypes') return ['WING'] as never
      if (op === 'model') return tree(engine.mock.calls.some(c => c[0] === 'addGeom') ? [geom] : []) as never
      if (op === 'addGeom') return { id: 'g' } as never
      throw Error('unexpected')
    })
    const service = createBrowserModelingService()
    let reads = 0
    try {
      expect(await service.write.create({ type: 'WING', parentId: null }, { sessionId: 'tab', get modelEpoch() { return ++reads === 1 ? '42' : '43' } })).toEqual({ geometryId: 'g' })
      expect(reads).toBe(1)
      expect(engine.mock.calls.map(c => c[0])).toEqual(['model', 'geomTypes', 'addGeom', 'model'])
      expect(engine.mock.calls.every(c => c[4] === '42' && c[5] instanceof AbortSignal)).toBe(true)
      expect(engine).toHaveBeenCalledWith('addGeom', 'WING', '', 0, '42', expect.any(AbortSignal))
    } finally { service.close(); engine.mockReset() }
  })

  it('moves and verifies the origin with guarded requests', async () => {
    const engine = vi.mocked(callGuarded)
    let moved = false
    engine.mockReset().mockImplementation(async op => {
      if (op === 'model') return tree([geom]) as never
      if (op === 'origin') return (moved ? [1, 2, 3] : [0, 0, 0]) as never
      if (op === 'move') { moved = true; return { ok: true } as never }
      throw Error('unexpected')
    })
    const service = createBrowserModelingService()
    try {
      expect(await service.write.move({ geometryId: 'g', frame: 'world', units: 'model-native', delta: [1, 2, 3] }, token)).toEqual({ geometryId: 'g', origin: [1, 2, 3] })
      expect(engine.mock.calls.map(c => c[0])).toEqual(['model', 'origin', 'move', 'model', 'origin'])
      expect(engine).toHaveBeenCalledWith('move', 'g', '1,2,3', 0, '42', expect.any(AbortSignal))
      expect(engine.mock.calls.every(c => c[4] === '42')).toBe(true)
    } finally { service.close(); engine.mockReset() }
  })

  it.each([['geometry', 'geomSetParm'], ['crossSection', 'xsecSetParm']] as const)('routes %s parameter writes to %s', async (owner, op) => {
    const engine = vi.mocked(callGuarded)
    engine.mockReset().mockResolvedValue({ actual: 3 })
    const service = createBrowserModelingService()
    try {
      expect(await service.parameter.set({ owner, ownerId: 'g', parameterId: 'p', value: 3 }, token)).toEqual({ actual: 3 })
      expect(engine).toHaveBeenCalledExactlyOnceWith(op, 'g', 'p', 3, '42', expect.any(AbortSignal))
    } finally { service.close(); engine.mockReset() }
  })

  it('preserves stale not-written errors and treats unverified writes as unknown', async () => {
    const engine = vi.mocked(callGuarded)
    const service = createBrowserModelingService()
    try {
      engine.mockReset().mockRejectedValueOnce(new WasmEngineError(409, 'private', 'not_written', null, 'STALE_MODEL'))
      await expect(service.parameter.set({ owner: 'geometry', ownerId: 'g', parameterId: 'p', value: 3 }, token)).rejects.toMatchObject({ code: 'STALE_MODEL', details: { outcome: 'not_written' } })
      engine.mockResolvedValueOnce({ actual: 4 })
      await expect(service.parameter.set({ owner: 'geometry', ownerId: 'g', parameterId: 'p', value: 3 }, token)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    } finally { service.close(); engine.mockReset() }
  })

  it('maps stale preflight and stale not-written create without retry', async () => {
    const engine = vi.mocked(callGuarded)
    const service = createBrowserModelingService()
    try {
      engine.mockReset().mockImplementation(async op => {
        if (op === 'model') throw new WasmEngineError(409, 'private', undefined, null, 'STALE_MODEL')
        if (op === 'geomTypes') return ['WING'] as never
        throw Error('unexpected')
      })
      await expect(service.write.create({ type: 'WING', parentId: null }, token)).rejects.toMatchObject({ code: 'STALE_MODEL' })
      expect(engine.mock.calls.some(c => c[0] === 'addGeom')).toBe(false)
      engine.mockReset().mockImplementation(async op => {
        if (op === 'model') return tree([]) as never
        if (op === 'geomTypes') return ['WING'] as never
        if (op === 'addGeom') throw new WasmEngineError(409, 'private', 'not_written', null, 'STALE_MODEL')
        throw Error('unexpected')
      })
      await expect(service.write.create({ type: 'WING', parentId: null }, token)).rejects.toMatchObject({ code: 'STALE_MODEL' })
      expect(engine.mock.calls.filter(c => c[0] === 'addGeom')).toHaveLength(1)
    } finally { service.close(); engine.mockReset() }
  })

  it('treats stale readback after creation as an unknown outcome', async () => {
    const engine = vi.mocked(callGuarded)
    let written = false
    engine.mockReset().mockImplementation(async op => {
      if (op === 'geomTypes') return ['WING'] as never
      if (op === 'model') {
        if (written) throw new WasmEngineError(409, 'private', undefined, null, 'STALE_MODEL')
        return tree([]) as never
      }
      if (op === 'addGeom') { written = true; return { id: 'g' } as never }
      throw Error('unexpected')
    })
    const service = createBrowserModelingService()
    try {
      await expect(service.write.create({ type: 'WING', parentId: null }, token)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      expect(engine.mock.calls.filter(c => c[0] === 'addGeom')).toHaveLength(1)
    } finally { service.close(); engine.mockReset() }
  })

  it('distinguishes closure before and after dispatch', async () => {
    const engine = vi.mocked(callGuarded)
    engine.mockReset().mockReturnValue(new Promise(() => {}))
    const service = createBrowserModelingService()
    const pending = service.parameter.set({ owner: 'geometry', ownerId: 'g', parameterId: 'p', value: 3 }, token)
    service.close()
    await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    await expect(service.parameter.set({ owner: 'geometry', ownerId: 'g', parameterId: 'p', value: 3 }, token)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(engine).toHaveBeenCalledOnce()
    engine.mockReset()
  })
})
