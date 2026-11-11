import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyFileError, safelyNotifyFileError, useFileNotice } from './fileNotice'

afterEach(() => { vi.useRealTimers(); useFileNotice.setState({ notice: null }) })
describe('file error notices', () => {
  it('replaces old notices and expires only the latest', () => {
    vi.useFakeTimers()
    notifyFileError({ kind: 'busy', operation: 'open', name: 'a.vsp3' })
    vi.advanceTimersByTime(9000)
    notifyFileError({ kind: 'busy', operation: 'save', name: 'b.vsp3' })
    vi.advanceTimersByTime(1000)
    expect(useFileNotice.getState().notice?.name).toBe('b.vsp3')
    vi.advanceTimersByTime(9000)
    expect(useFileNotice.getState().notice).toBeNull()
  })
  it('swallows notification listener exceptions', () => {
    const unsubscribe = useFileNotice.subscribe(() => { throw Error('listener') })
    expect(() => safelyNotifyFileError({ kind: 'busy', operation: 'open' })).not.toThrow()
    unsubscribe()
  })
})
