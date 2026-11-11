import { describe, expect, it, vi } from 'vitest'
import { normalizeImportName, stageImport } from './importStaging'

describe('import staging', () => {
  it.each(['', '.', '..', './a', '../a', 'a/b', 'a\\b', '\0a', 'a:b', 'a\nb'])(
    'rejects unsafe basename %j', name => expect(() => normalizeImportName(name)).toThrow(),
  )

  it('preserves exact names and case; rejects exact duplicates before fetching', async () => {
    const getData = vi.fn(() => new Uint8Array([1]))
    await expect(stageImport([{ name: 'A' }, { name: 'a' }], getData, 2)).resolves.toMatchObject([{ name: 'A' }, { name: 'a' }])
    getData.mockClear()
    await expect(stageImport([{ name: 'A' }, { name: 'A' }], getData, 2)).rejects.toThrow(/Duplicate/)
    expect(getData).not.toHaveBeenCalled()
  })

  it('rejects asynchronously without exposing partial staging', async () => {
    const error = new Error('read failed')
    const getData = vi.fn().mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(error)
    await expect(stageImport([{ name: 'a' }, { name: 'b' }], getData, 10)).rejects.toBe(error)
    expect(getData).toHaveBeenCalledTimes(2)
  })

  it('rejects throwing and changing name getters before reading data', async () => {
    const getData = vi.fn(() => new Uint8Array())
    const bad = Object.defineProperty({}, 'name', { get() { throw new Error('getter') } }) as { name: string }
    await expect(stageImport([{ name: 'a' }, bad], getData, 1)).rejects.toThrow('getter')
    expect(getData).not.toHaveBeenCalled()
    let reads = 0
    const changing = { get name() { return ++reads === 1 ? 'safe' : '../unsafe' } }
    expect((await stageImport([changing], getData, 1))[0].name).toBe('safe')
    expect(reads).toBe(1)
  })

  it('checks the combined limit and accepts the exact boundary', async () => {
    const sources = [{ name: 'a' }, { name: 'b' }]
    const getData = () => new Uint8Array([1, 2])
    await expect(stageImport(sources, getData, 4)).resolves.toHaveLength(2)
    await expect(stageImport(sources, getData, 3)).rejects.toThrow(/limit/)
    for (const limit of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(stageImport(sources, getData, limit)).rejects.toThrow()
    }
  })

  it('copies visible bytes independently even if sources change during later reads', async () => {
    const backing = new Uint8Array([9, 1, 2, 9])
    const view = backing.subarray(1, 3)
    const result = await stageImport([{ name: 'a' }, { name: 'b' }], source => {
      if (source.name === 'b') backing[1] = 7
      return view
    }, 4)
    backing.fill(0)
    expect([...result[0].data]).toEqual([1, 2])
    expect([...result[1].data]).toEqual([7, 2])
    result[0].data[1] = 5
    expect([...result[1].data]).toEqual([7, 2])
    expect(result[0].data.buffer).not.toBe(result[1].data.buffer)
  })

  it('rejects empty or malformed inputs, and accepts empty files', async () => {
    const getData = () => new Uint8Array()
    await expect(stageImport([], getData, 0)).rejects.toThrow()
    await expect(stageImport([null as never], getData, 0)).rejects.toThrow()
    await expect(stageImport([{ name: 1 } as never], getData, 0)).rejects.toThrow()
    await expect(stageImport([{ name: 'a' }], () => null as never, 0)).rejects.toThrow()
    await expect(stageImport([{ name: 'a' }], getData, 0)).resolves.toHaveLength(1)
  })

  it('does not trust typed-array size getters or forged typed arrays', async () => {
    const data = new Uint8Array([1, 2])
    Object.defineProperty(data, 'byteLength', { get() { throw new Error('malicious') } })
    await expect(stageImport([{ name: 'a' }], () => data, 1)).rejects.toThrow(/limit/)
    await expect(stageImport([{ name: 'a' }], () => data, 2)).resolves.toMatchObject([{ data: new Uint8Array([1, 2]) }])
    const fake = Object.create(Uint8Array.prototype) as Uint8Array
    await expect(stageImport([{ name: 'a' }], () => fake, 2)).rejects.toThrow()
  })
})
