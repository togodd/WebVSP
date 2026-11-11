import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Binding = { handle: unknown; pending: boolean; writing: boolean }
type Files = {
  answer(vsp: unknown, dialog: unknown): Promise<void>
  watch(vsp: unknown): void
  clear(): void
  state(path: string): Binding | undefined
}
let files: Files
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  await import('./wasmEngine')
  files = (window as unknown as { __webvspEngine: { testFiles: Files } }).__webvspEngine.testFiles
})
beforeEach(() => files.clear())
afterAll(() => { files.clear(); vi.unstubAllGlobals() })

const path = '/home/web_user/shared.vsp3'
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function setup() {
  let file: { bytes: Uint8Array; time: number } | undefined
  const events: { seq: number; result: number; path: string }[] = []
  const deliveries: number[][][] = [[], []]
  const handles = deliveries.map(writes => ({
    name: 'shared.vsp3',
    queryPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (bytes: Uint8Array) => { writes.push(Array.from(bytes)) },
      close: async () => {},
    }),
  }))
  let pick = 0
  Object.assign(window, { showSaveFilePicker: async () => handles[pick++] })
  const vsp = {
    FS: {
      analyzePath: (p: string) => ({ exists: p === path && !!file }),
      stat: (p: string) => {
        if (p !== path || !file) throw { errno: 44 } // Emscripten ENOENT
        return { mtime: new Date(file.time), size: file.bytes.length }
      },
      readFile: (p: string) => {
        if (p !== path || !file) throw Error('missing')
        return file.bytes
      },
      mkdirTree: () => {},
    },
    mirrorEvent: (json: string) => events.push(JSON.parse(json)),
  }
  const answer = (seq: number) => files.answer(vsp, { seq, mode: 1, filter: '*.vsp3' })
  const write = (bytes: number[]) => { file = { bytes: new Uint8Array(bytes), time: 1 } }
  return { vsp, events, handles, deliveries, answer, write }
}

// Characterizes a synthetic ordering and current risk, not proof that the GUI can trigger it.
describe('same-name Save picker delayed-write characterization', () => {
  it('routes the first request’s delayed bytes to the later handle after both answers', async () => {
    const s = setup()
    expect(s.handles[0]).not.toBe(s.handles[1])
    await s.answer(1)
    expect(files.state(path)?.handle).toBe(s.handles[0])
    await s.answer(2) // Neither answer has caused an FS write in this simulation.
    expect(s.events).toEqual([
      expect.objectContaining({ seq: 1, result: 1, path }),
      expect.objectContaining({ seq: 2, result: 1, path }),
    ])
    expect(files.state(path)?.handle).toBe(s.handles[1])
    expect(s.deliveries).toEqual([[], []])

    s.write([17, 34, 51]) // Simulate the first request writing only now.
    files.watch(s.vsp)
    expect(files.state(path)?.pending).toBe(true)
    files.watch(s.vsp)
    await flush()
    expect(s.deliveries).toEqual([[], [[17, 34, 51]]])
    expect(files.state(path)).toMatchObject({ pending: false, writing: false })
  })

  it.each(['metadata changed', 'pending'] as const)('rejects the second selection when %s', async condition => {
    const s = setup()
    await s.answer(1)
    const binding = files.state(path)
    s.write([7, 8])
    if (condition === 'pending') {
      files.watch(s.vsp)
      expect(binding?.pending).toBe(true)
    } else {
      expect(binding?.pending).toBe(false)
    }
    await s.answer(2)
    expect(s.events).toEqual([
      expect.objectContaining({ seq: 1, result: 1, path }),
      expect.objectContaining({ seq: 2, result: 0, path: '' }),
    ])
    expect(files.state(path)).toBe(binding)
    expect(binding?.handle).toBe(s.handles[0])
    expect(s.deliveries).toEqual([[], []])
  })
})
