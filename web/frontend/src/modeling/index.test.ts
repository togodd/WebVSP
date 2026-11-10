import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ api: { model: vi.fn(), bbox: vi.fn() } }))
vi.mock('../api/wasmEngine', () => ({
  getEngineSessionId: () => 'tab',
  callGuarded: vi.fn(async () => ({ modelEpoch: '42', modelEpochValid: true, fileName: '', rev: 1, version: '', geoms: [], active: [] })),
  WasmEngineError: class extends Error {},
}))

import { callGuarded } from '../api/wasmEngine'
import { createBrowserModelingService } from './index'

describe('browser modeling identity', () => {
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
    expect(callGuarded).toHaveBeenCalledWith('model', '', '', 0, '42')
    expect([sessions, epochs]).toEqual([1, 1])
    service.close()
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
