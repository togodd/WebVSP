import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ api: { bbox: vi.fn() } }))
vi.mock('../api/wasmEngine', () => ({
  getEngineSessionId: () => 'tab',
  discoverModel: vi.fn(),
  discoverModelingProtocol: vi.fn(),
  callGuarded: vi.fn(),
  WasmEngineError: class extends Error {},
}))

import { discoverModelingProtocol } from '../api/wasmEngine'
import { createBrowserModelingService } from './index'
import { createBrowserReadApi } from './browserReadApi'

describe('browser read wrapper session lifetime', () => {
  it('does not cancel a pending read when an independent call completes', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(discoverModelingProtocol).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const services: ReturnType<typeof createBrowserModelingService>[] = []
    const closes: ReturnType<typeof vi.spyOn>[] = []
    const api = createBrowserReadApi(() => {
      const service = createBrowserModelingService()
      services.push(service)
      closes.push(vi.spyOn(service, 'close'))
      return service
    })
    let settled = false
    const pending = api.protocol().finally(() => { settled = true })
    try {
      const signal = vi.mocked(discoverModelingProtocol).mock.calls.at(-1)?.[0]
      await api.capabilities()
      expect(services).toHaveLength(2)
      expect(closes[0]).not.toHaveBeenCalled()
      expect(closes[1]).toHaveBeenCalledTimes(1)
      expect(signal?.aborted).toBe(false)
      expect(settled).toBe(false)
      resolve({ protocol: 'webvsp-modeling', version: 1, operations: [] })
      await expect(pending).resolves.toEqual({ status: 'valid', operations: [] })
      expect(closes[0]).toHaveBeenCalledTimes(1)
      expect(signal?.aborted).toBe(true)
    } finally {
      resolve({ protocol: 'webvsp-modeling', version: 1, operations: [] })
      await pending.catch(() => {})
      vi.mocked(discoverModelingProtocol).mockReset()
    }
  })

  it('closes after an externally closed pending session rejects and consumes a late engine rejection', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(discoverModelingProtocol).mockReturnValueOnce(new Promise((_resolve, r) => { reject = r }))
    const service = createBrowserModelingService()
    const close = vi.spyOn(service, 'close')
    const api = createBrowserReadApi(() => service)
    const pending = api.protocol()
    const signal = vi.mocked(discoverModelingProtocol).mock.calls.at(-1)?.[0]
    try {
      expect(signal?.aborted).toBe(false)
      service.close()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(signal?.aborted).toBe(true)
      expect(close).toHaveBeenCalledTimes(2) // external close, then wrapper finally
      reject(new Error('late engine failure'))
      await Promise.resolve()
    } finally {
      reject(new Error('late engine failure'))
      await pending.catch(() => {})
      vi.mocked(discoverModelingProtocol).mockReset()
    }
  })
})
