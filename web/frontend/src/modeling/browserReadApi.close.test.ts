import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ api: { bbox: vi.fn() } }))
vi.mock('../api/wasmEngine', () => ({
  getEngineSessionId: () => 'tab',
  discoverModel: vi.fn(),
  discoverModelingProtocol: vi.fn(),
  callGuarded: vi.fn(),
  WasmEngineError: class extends Error {},
}))

import { callGuarded, discoverModelingProtocol } from '../api/wasmEngine'
import { createBrowserModelingService } from './index'
import { createBrowserReadApi } from './browserReadApi'

describe('browser read wrapper session lifetime', () => {
  it('propagates external close through the wrapper and disposes after the scoped read', async () => {
    const tree = { geoms: [], active: [], modelEpoch: '42', modelEpochValid: true, rev: 1, version: 'v', fileName: '' }
    const token = { sessionId: 'tab', modelEpoch: '42' }
    for (const kind of ['info', 'selection', 'list', 'get'] as const) {
      for (const late of [false, true]) {
        const delay = (kind === 'info' ? 4 : 5) + Number(late)
        vi.mocked(callGuarded).mockResolvedValueOnce(tree)
        const service = createBrowserModelingService()
        const events: string[] = []
        const originalClose = service.close.bind(service)
        const closeSpy = vi.spyOn(service, 'close').mockImplementation(() => { events.push('wrapper-close'); originalClose() })
        const factory = vi.fn(() => service)
        const api = createBrowserReadApi(factory)
        const pending = (kind === 'info' ? api.model.getInfo(token) : kind === 'selection' ? api.model.getSelection(token) : kind === 'list' ? api.geometry.list(token) : api.geometry.get('missing', token)).then(() => { events.push('consumer'); return 'success' }, error => { events.push('consumer'); return error.code })
        let remaining = delay
        const close = () => { if (remaining-- === 0) { events.push('external-close'); originalClose() } else queueMicrotask(close) }
        queueMicrotask(close)
        // The adjacent schedules straddle an internal continuation, not necessarily
        // settlement of the wrapper promise or observation by its consumer.
        expect(await pending).toBe(late ? (kind === 'get' ? 'GEOMETRY_NOT_FOUND' : 'success') : 'SESSION_CLOSED')
        expect(factory).toHaveBeenCalledOnce()
        expect(closeSpy).toHaveBeenCalledOnce()
        expect(events).toEqual(['external-close', 'wrapper-close', 'consumer'])
      }
    }
  })
  it.each(['no close', 'before inner settlement', 'after inner settlement'] as const)(
    'preserves the rejection outcome with external close %s', async (timing) => {
      let rejectAdapter!: (reason: Error) => void
      vi.mocked(discoverModelingProtocol).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectAdapter = reject }))
      const service = createBrowserModelingService()
      const originalClose = service.close.bind(service)
      const events: string[] = []
      const closeSpy = vi.spyOn(service, 'close').mockImplementation(() => { events.push('wrapper-close'); originalClose() })
      const originalProtocol = service.protocol.bind(service)
      let innerSettled = false
      let outerSettled = false
      let outerSettledAtExternalClose: boolean | undefined
      vi.spyOn(service, 'protocol').mockImplementation(() => {
        const inner = originalProtocol()
        // Register before run() awaits this same promise: this observes the real
        // service promise settling, not the adapter or the consumer settling.
        void inner.then(() => { innerSettled = true }, () => {
          innerSettled = true
          events.push('inner-rejected')
          if (timing === 'after inner settlement') {
            outerSettledAtExternalClose = outerSettled
            events.push('external-close')
            originalClose()
          }
        })
        return inner
      })
      const factory = vi.fn(() => service)
      const api = createBrowserReadApi(factory)
      const pending = api.protocol().then(
        () => { outerSettled = true; events.push('outer-fulfilled'); return 'success' },
        error => { outerSettled = true; events.push('outer-rejected'); return error.code },
      )
      try {
        rejectAdapter(new Error('adapter failed'))
        expect(innerSettled).toBe(false)
        expect(outerSettled).toBe(false)
        if (timing === 'before inner settlement') {
          events.push('external-close')
          originalClose()
        }
        expect(await pending).toBe(timing === 'before inner settlement' ? 'SESSION_CLOSED' : 'ENGINE_ERROR')
        expect(innerSettled).toBe(true)
        expect(outerSettled).toBe(true)
        if (timing === 'after inner settlement') expect(outerSettledAtExternalClose).toBe(false)
        expect(factory).toHaveBeenCalledOnce()
        expect(closeSpy).toHaveBeenCalledOnce()
        expect(events).toEqual(timing === 'before inner settlement'
          ? ['external-close', 'inner-rejected', 'wrapper-close', 'outer-rejected']
          : timing === 'after inner settlement'
            ? ['inner-rejected', 'external-close', 'wrapper-close', 'outer-rejected']
            : ['inner-rejected', 'wrapper-close', 'outer-rejected'])
      } finally {
        rejectAdapter(new Error('adapter failed'))
        await pending
        vi.mocked(discoverModelingProtocol).mockReset()
      }
    },
  )

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
