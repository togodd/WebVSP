import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../api/wasmEngine', () => ({
  WasmEngineError: class extends Error {
    status: number
    outcome?: string
    actual?: number
    code?: string
    constructor(status: number, message: string, outcome?: string, actual?: number, code?: string) {
      super(message); this.status = status; this.outcome = outcome; this.actual = actual; this.code = code
    }
  },
  syncProbeEngineCall: engine.call,
  callGuarded: vi.fn(), wasmRequest: vi.fn(), syncProbeFileExperiment: vi.fn(),
}))
import { runSyncScript } from './syncProbe'

class FakeWorker {
  static instance: FakeWorker
  onmessage!: (event: MessageEvent) => void
  onerror = null
  onmessageerror = null
  constructor() { FakeWorker.instance = this }
  postMessage() {}
  terminate() {}
  async request(op: string, args: object) {
    const buffer = new SharedArrayBuffer(8 + 65536)
    this.onmessage({ data: { type: 'request', op, args: JSON.stringify(args), buffer } } as MessageEvent)
    for (let i = 0; i < 10 && Atomics.load(new Int32Array(buffer, 0, 2), 0) === 0; i++) await Promise.resolve()
    const control = new Int32Array(buffer, 0, 2)
    expect(Atomics.load(control, 0)).toBe(1)
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, Atomics.load(control, 1))))
  }
}

describe('live write bridge', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('crossOriginIsolated', true)
    vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
    engine.call.mockReset()
  })
  it('distinguishes rejected validation from dispatched errors and preserves metadata', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    expect((await worker.request('live_parm_set', { geom_id: 'g', key: 'k', value: null })).error.outcome).toBe('not_written')
    expect(engine.call).not.toHaveBeenCalled()
    engine.call.mockRejectedValueOnce(new Error('lost'))
    expect((await worker.request('live_parm_set', { geom_id: 'g', key: 'k', value: 1 })).error.outcome).toBe('unknown')
    const { WasmEngineError } = await import('../api/wasmEngine')
    engine.call.mockRejectedValueOnce(new WasmEngineError(400, 'rejected', 'not_written', 4, 'GUARD'))
    expect((await worker.request('live_parm_set', { geom_id: 'g', key: 'k', value: 1 })).error).toMatchObject({ outcome: 'not_written', actual: 4, code: 'GUARD' })
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards only valid clone deletion policies without dispatching invalid ones', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    for (const policy of [0, 1, 2]) {
      expect((await worker.request('live_delete_geom', { geom_id: 'g', clone_delete: policy })).ok).toBe(true)
      expect(engine.call).toHaveBeenLastCalledWith('liveDeleteGeom', 'g', '', policy)
    }
    engine.call.mockClear()
    for (const policy of [-1, 3, 1.5, '1', null, true]) {
      expect((await worker.request('live_delete_geom', { geom_id: 'g', clone_delete: policy })).error.outcome).toBe('not_written')
    }
    expect((await worker.request('live_delete_geom', { geom_id: 'g' })).error.outcome).toBe('not_written')
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('validates XSec and subsurface integer arguments before dispatch', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    const cases: [string, Record<string, unknown>, string][] = [
      ['live_insert_xsec', { geom_id: 'g', index: 0, shape: 1 }, 'index'],
      ['live_insert_xsec', { geom_id: 'g', index: 0, shape: 1 }, 'shape'],
      ['live_delete_xsec', { xsec_surf_id: 'g', index: 0 }, 'index'],
      ['live_change_xsec_shape', { xsec_id: 'x', shape: 1 }, 'shape'],
      ['live_add_sub_surf', { geom_id: 'g', type: 1, surf_index: 0 }, 'type'],
      ['live_add_sub_surf', { geom_id: 'g', type: 1, surf_index: 0 }, 'surf_index'],
    ]
    for (const [op, args, key] of cases) {
      for (const value of [1.5, 1e21, -2147483649, 2147483648, '1', null, true]) {
        expect((await worker.request(op, { ...args, [key]: value })).error.outcome).toBe('not_written')
      }
    }
    expect(engine.call).not.toHaveBeenCalled()
    for (const [op, args, key] of cases) {
      for (const value of [-2147483648, 2147483647]) {
        expect((await worker.request(op, { ...args, [key]: value })).ok).toBe(true)
      }
    }
    expect((await worker.request('live_add_sub_surf', { geom_id: 'g', type: 1 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveAddSubSurf', 'g', '1', 0)
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards subsurface metadata and reorder/name operations', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_sub_surf_type', { sub_id: 'ss' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveSubSurfType', 'ss', '', 0)
    expect((await worker.request('live_sub_surf_parm_ids', { sub_id: 'ss' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveSubSurfParmIDs', 'ss', '', 0)
    expect((await worker.request('live_sub_surf_index', { sub_id: 'ss' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveSubSurfIndex', 'ss', '', 0)
    expect((await worker.request('live_reorder_sub_surf', { geom_id: 'g', sub_id: 'ss', reorder_type: 2 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveReorderSubSurf', 'g', 'ss', 2)
    expect((await worker.request('live_set_sub_surf_name', { sub_id: 'ss', name: 'new' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveSetSubSurfNameID', 'ss', 'new', 0)
    expect((await worker.request('live_set_sub_surf_name', { geom_id: 'g', sub_id: 'ss', name: 'new' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveSetSubSurfName', 'g', 'ss\x1fnew', 0)
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('refuses a later write after a timed-out request is abandoned', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    worker.onmessage({ data: { type: 'abandon' } } as MessageEvent)
    expect((await worker.request('live_add_geom', { type: 'WING' })).error.outcome).toBe('not_written')
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
})
