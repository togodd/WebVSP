import { describe, expect, it, vi } from 'vitest'
import { drainBatch } from './drainBatch'

describe('drainBatch', () => {
  it('logs a failed proc and continues the batch in proc/out/mirror order', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error('spawn failed')
      const calls: string[] = []
      const mirror = ['mirror-1', 'mirror-2']
      drainBatch({ proc: ['proc-1', 'proc-2'], out: ['out-1', 'out-2'], mirror }, (proc) => {
        calls.push(proc)
        if (proc === 'proc-1') throw error
      }, (out) => calls.push(out), (messages) => {
        expect(messages).toBe(mirror)
        calls.push(...messages)
      })
      expect(calls).toEqual(['proc-1', 'proc-2', 'out-1', 'out-2', 'mirror-1', 'mirror-2'])
      expect(log.mock.calls).toEqual([['WebVSP process request:', error]])
    } finally {
      log.mockRestore()
    }
  })

  it('dispatches synchronously before microtasks queued by a proc handler', async () => {
    const calls: string[] = []
    drainBatch({ proc: [1], out: [2], mirror: [3] }, () => {
      calls.push('proc')
      void Promise.resolve().then(() => calls.push('microtask'))
    }, () => calls.push('out'), () => calls.push('mirror'))
    expect(calls).toEqual(['proc', 'out', 'mirror'])
    await Promise.resolve()
    expect(calls).toEqual(['proc', 'out', 'mirror', 'microtask'])
  })

  it('isolates each failed out handler and continues without leaking exceptions', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const calls: string[] = []
      drainBatch({ proc: [1], out: [1, 2], mirror: [1] }, () => calls.push('proc'), (out) => {
        calls.push(`out-${out}`)
        if (out === 1) throw new Error('secret')
      }, () => calls.push('mirror'))
      expect(calls).toEqual(['proc', 'out-1', 'out-2', 'mirror'])
      expect(log.mock.calls).toEqual([['WebVSP: output handler failed']])
    } finally {
      log.mockRestore()
    }
  })

  it('continues if logging fails after requestFull throws without falsely signaling ready', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('log failed') })
    try {
      const ready = vi.fn()
      const requestFull = vi.fn(() => { throw new Error('sensitive requestFull failure') })
      const next = vi.fn()
      const mirror = vi.fn()
      drainBatch({ proc: [], out: ['engine_ready', 'next'], mirror: ['mirror'] }, () => {}, (message) => {
        if (message === 'engine_ready') {
          requestFull()
          ready()
        } else next()
      }, mirror)
      expect(requestFull).toHaveBeenCalledOnce()
      expect(ready).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledOnce()
      expect(mirror).toHaveBeenCalledExactlyOnceWith(['mirror'])
      expect(log.mock.calls).toEqual([['WebVSP: output handler failed']])
    } finally {
      log.mockRestore()
    }
  })

  it('does not dispatch an empty mirror batch', () => {
    const handleMirror = vi.fn()
    drainBatch({ proc: [], out: [], mirror: [] }, () => {}, () => {}, handleMirror)
    expect(handleMirror).not.toHaveBeenCalled()
  })
})
