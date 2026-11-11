import { describe, expect, it, vi } from 'vitest'
import { stageImportWithMetadata } from './importStaging'

const limits = { maxCount: 2, maxBytes: 4, maxNameLength: 2, maxTotalNameLength: 3 }

describe('optional import metadata preflight', () => {
  it('accepts exact boundaries and zero sizes; copies actual bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const result = await stageImportWithMetadata([{ name: 'ab', size: 4 }, { name: 'c', size: 0 }],
      s => s.name === 'ab' ? bytes : new Uint8Array(), limits)
    bytes.fill(0)
    expect([...result[0].data]).toEqual([1, 2, 3, 4])
    expect(result[1].data.length).toBe(0)
  })

  it('checks every metadata entry before any read', async () => {
    const read = vi.fn(() => new Uint8Array())
    for (const sources of [
      [{ name: 'a', size: 0 }, { name: 'b', size: -1 }],
      [{ name: 'a', size: 3 }, { name: 'b', size: 2 }],
      [{ name: 'a', size: 0 }, { name: '../b', size: 0 }],
      [{ name: 'a', size: 0 }, { name: 'a', size: 0 }],
      [{ name: 'ab', size: 0 }, { name: 'cd', size: 0 }],
      [{ name: 'abc', size: 0 }],
      [{ name: 'a', size: 0 }, { name: 'b', size: 0 }, { name: 'c', size: 0 }],
      [],
    ]) {
      await expect(stageImportWithMetadata(sources, read, limits)).rejects.toThrow()
      expect(read).not.toHaveBeenCalled()
    }
  })

  it.each([-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid size %s', async size => {
    const read = vi.fn()
    await expect(stageImportWithMetadata([{ name: 'a', size }], read, limits)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['maxCount', 'maxBytes', 'maxNameLength', 'maxTotalNameLength'] as const)(
    'validates %s as a nonnegative safe integer', async key => {
      for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const read = vi.fn()
        await expect(stageImportWithMetadata([{ name: 'a', size: 0 }], read, { ...limits, [key]: value })).rejects.toThrow()
        expect(read).not.toHaveBeenCalled()
      }
    },
  )

  it('rejects a long name before accessing size or reading data', async () => {
    const size = vi.fn(() => { throw Error('size should not be accessed') })
    const read = vi.fn()
    await expect(stageImportWithMetadata([{ name: 'long', get size() { return size() } }], read, limits))
      .rejects.toThrow('name length limit')
    expect(size).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects cumulative safe-integer overflow without arithmetic overflow', async () => {
    const read = vi.fn()
    await expect(stageImportWithMetadata([{ name: 'a', size: Number.MAX_SAFE_INTEGER }, { name: 'b', size: 1 }], read,
      { ...limits, maxBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('checks actual bytes even when declared sizes understate them', async () => {
    await expect(stageImportWithMetadata([{ name: 'a', size: 0 }], () => new Uint8Array(5), limits)).rejects.toThrow(/limit/)
  })

  it('snapshots names and reads metadata only once, including before async data reads', async () => {
    let nameReads = 0, sizeReads = 0
    const source = { get name() { return ++nameReads === 1 ? 'a' : '../bad' }, get size() { sizeReads++; return 1 } }
    const result = await stageImportWithMetadata([source], async () => new Uint8Array([1]), limits)
    expect(result[0].name).toBe('a')
    expect(nameReads).toBe(1)
    expect(sizeReads).toBe(1)
  })

  it('propagates metadata getter errors before reading and counts UTF-16 units', async () => {
    const read = vi.fn()
    const error = new Error('metadata')
    await expect(stageImportWithMetadata([{ name: 'a', get size(): number { throw error } }], read, limits)).rejects.toBe(error)
    expect(read).not.toHaveBeenCalled()
    await expect(stageImportWithMetadata([{ name: '😀', size: 0 }], () => new Uint8Array(), { ...limits, maxNameLength: 1 })).rejects.toThrow()
  })

  it('rejects malformed inputs and a proxy with an invalid count before reading', async () => {
    const read = vi.fn()
    const proxy = new Proxy([{ name: 'a', size: 0 }], { get(target, key, receiver) {
      return key === 'length' ? 1.5 : Reflect.get(target, key, receiver)
    } })
    await expect(stageImportWithMetadata(proxy, read, limits)).rejects.toThrow()
    await expect(stageImportWithMetadata([null as never], read, limits)).rejects.toThrow()
    await expect(stageImportWithMetadata([{ name: 'a', size: '1' } as never], read, limits)).rejects.toThrow()
    await expect(stageImportWithMetadata([{ name: 'a', size: 0 }], null as never, limits)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})
