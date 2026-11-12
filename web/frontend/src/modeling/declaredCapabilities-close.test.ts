import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ api: { model: vi.fn(), bbox: vi.fn() } }))
vi.mock('../api/wasmEngine', () => ({
  getEngineSessionId: () => 'tab',
  discoverModel: vi.fn(),
  discoverModelingProtocol: vi.fn(),
  callGuarded: vi.fn(),
  WasmEngineError: class extends Error {},
}))

import { discoverModelingProtocol } from '../api/wasmEngine'
import { createBrowserModelingService } from './index'

const manifest = () => ({ protocol: 'webvsp-modeling', version: 1, operations: [] })

describe('declaredCapabilities protocol promise lifecycle', () => {
  it('returns a rejected promise without calling the adapter after close', async () => {
    const request = vi.mocked(discoverModelingProtocol)
    request.mockReset()
    const service = createBrowserModelingService()
    service.close()
    const pending = service.declaredCapabilities()
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a completed declaration usable after close but rejects subsequent calls', async () => {
    const request = vi.mocked(discoverModelingProtocol)
    request.mockReset().mockResolvedValue(manifest())
    const service = createBrowserModelingService()
    try {
      const result = await service.declaredCapabilities()
      service.close()
      expect(result.find(c => c.name === 'model.read')?.status).toBe('not_declared')
      await expect(service.declaredCapabilities()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(request).toHaveBeenCalledOnce()
    } finally { service.close(); request.mockReset() }
  })

  it.each(['throw', 'reject'] as const)('prioritizes synchronous reentrant close over adapter %s', async outcome => {
    const request = vi.mocked(discoverModelingProtocol)
    const service = createBrowserModelingService()
    const secret = new Error('private adapter error')
    request.mockReset().mockImplementation(() => {
      service.close()
      if (outcome === 'throw') throw secret
      return Promise.reject(secret)
    })
    try {
      const pending = service.declaredCapabilities()
      expect(pending).toBeInstanceOf(Promise)
      const error = await pending.then(() => null, e => e)
      expect(error).toMatchObject({ code: 'SESSION_CLOSED' })
      expect(error).not.toBe(secret)
      expect(request).toHaveBeenCalledOnce()
      expect(request.mock.calls[0][0]?.aborted).toBe(true)
    } finally { service.close(); request.mockReset() }
  })

  it.each(['resolve', 'reject'] as const)('does not inspect a late %s after close', async outcome => {
    const request = vi.mocked(discoverModelingProtocol)
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
    request.mockReset().mockReturnValue(new Promise((a, b) => { resolve = a; reject = b }))
    const service = createBrowserModelingService()
    const inspect = vi.fn(() => { throw new Error('late value inspected') })
    const hostile = new Proxy(manifest(), { get: inspect, getOwnPropertyDescriptor: inspect, getPrototypeOf: inspect })
    try {
      const pending = service.declaredCapabilities()
      service.close()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      // Promise resolution itself must inspect `then`; use a non-hostile manifest for
      // the resolve case and observe parsing through its own-property trap instead.
      if (outcome === 'resolve') resolve(new Proxy(manifest(), { getOwnPropertyDescriptor: inspect }))
      else reject(hostile)
      await new Promise<void>(done => setTimeout(done, 0))
      expect(inspect).not.toHaveBeenCalled()
      await expect(service.declaredCapabilities()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(request).toHaveBeenCalledOnce()
    } finally { service.close(); request.mockReset() }
  })
})
