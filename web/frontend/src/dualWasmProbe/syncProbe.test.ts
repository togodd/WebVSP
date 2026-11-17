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

const encoder = new TextEncoder()

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
  it('forwards typed analysis inputs and validates writes', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    for (const [kind, native] of [['int', 'Int'], ['double', 'Double'], ['string', 'String']] as const) {
      expect((await worker.request('live_analysis_get_' + kind, { analysis: 'A', name: 'N', index: 2 })).ok).toBe(true)
      expect(engine.call).toHaveBeenLastCalledWith('liveAnalysisGet' + native, 'A', 'N', 2)
    }
    for (const value of ['', '你好\n😀', 'a;b:c']) {
      expect((await worker.request('live_analysis_set_string', { analysis: 'A', name: 'N', values: [value, value], index: 0 })).ok).toBe(true)
      const packet = `${3};1:N${encoder.encode(value).length}:${value}${encoder.encode(value).length}:${value}`
      expect(engine.call).toHaveBeenLastCalledWith('liveAnalysisSetString', 'A', packet, 0)
    }
    expect((await worker.request('live_analysis_set_double', { analysis: 'A', name: 'N', values: [1.5, -2.25], index: 2 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveAnalysisSetDouble', 'A', '3;1:N3:1.55:-2.25', 2)
    expect((await worker.request('live_analysis_set_int', { analysis: 'A', name: 'N', values: [] })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveAnalysisSetInt', 'A', '1;1:N', 0)
    engine.call.mockClear()
    expect((await worker.request('live_analysis_set_string', { analysis: 'A', name: 'N', values: ['\0'] })).error.outcome).toBe('not_written')
    expect((await worker.request('live_analysis_set_int', { analysis: 'A', name: 'N', values: [2147483648] })).error.outcome).toBe('not_written')
    expect((await worker.request('live_analysis_set_double', { analysis: 'A', name: 'N', values: [1.5], index: -1 })).error.outcome).toBe('not_written')
    expect((await worker.request('live_analysis_get_int', { analysis: 'A', name: 'N', index: -1 })).ok).toBe(false)
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards VSPAERO reference, mode and control group calls', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_vspaero_ref_wing', {})).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAERORefWing', '', '', 0)
    expect((await worker.request('live_vspaero_set_ref_wing', { geom_id: 'g' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROSetRefWing', 'g', '', 0)
    expect((await worker.request('live_vspaero_set_cg_mode', { mode_id: 'm' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROSetCGMode', 'm', '', 0)
    expect((await worker.request('live_vspaero_auto_group', {})).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROAutoGroup', '', '', 0)
    expect((await worker.request('live_vspaero_add_all_cs_group', { index: 2 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROAddAllCSGroup', '', '', 2)
    expect((await worker.request('live_vspaero_set_cs_name', { name: 'Flap', index: 1 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROSetCSName', 'Flap', '', 1)
    engine.call.mockClear()
    expect((await worker.request('live_vspaero_delete_cs_group', { index: -1 })).error.outcome).toBe('not_written')
    expect((await worker.request('live_vspaero_get_cs_name', { index: 0.5 })).ok).toBe(false)
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards VSPAERO output and the kill request', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_vspaero_output', {})).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROOutput', '', '', 0)
    expect((await worker.request('live_vspaero_kill', {})).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROKill', '', '', 0)
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards the VSPAERO product listing', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_vspaero_files', {})).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveVSPAEROFiles', '', '', 0)
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards surface vector queries and projection', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_comp_vec_pnt01', { geom_id: 'g', surf_indx: 0, us: [0.1, 0.2], ws: [0.3, 0.4] })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveCompVecPnt01', 'g', '5;1:03:0.13:0.23:0.33:0.4', 0)
    expect((await worker.request('live_comp_vec_norm01', { geom_id: 'g', surf_indx: 1, us: [0.5], ws: [0.5] })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveCompVecNorm01', 'g', '3;1:13:0.53:0.5', 0)
    expect((await worker.request('live_proj_pnt01', { geom_id: 'g', surf_indx: 0, point: [1, 2, 3] })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveProjPnt01', 'g', '0\x1f1\x1f2\x1f3', 0)
    expect((await worker.request('live_comp_curvature01', { geom_id: 'g', surf_indx: 0, u: 0.25, w: 0.75 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveCompCurvature01', 'g', '0\x1f0.75', 0.25)
    expect((await worker.request('live_uw_tess01', { geom_id: 'g', surf_indx: 2 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveUWTess01', 'g', '2', 0)
    engine.call.mockClear()
    expect((await worker.request('live_comp_vec_pnt01', { geom_id: 'g', surf_indx: 0, us: [0.1], ws: [0.2, 0.3] })).ok).toBe(false)
    expect((await worker.request('live_proj_pnt01', { geom_id: 'g', surf_indx: 0, point: [1, 2] })).ok).toBe(false)
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards parameter metadata and batch geometry edits', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_parm_descript', { parm_id: 'p' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveParmDescript', 'p', '', 0)
    expect((await worker.request('live_parm_container', { parm_id: 'p' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveParmContainer', 'p', '', 0)
    expect((await worker.request('live_parm_set_limits', { parm_id: 'p', values: [0.5, 0.1, 0.9] })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveParmSetLimits', 'p', '0.1\x1f0.9', 0.5)
    expect((await worker.request('live_clone_geom_vec', { geom_ids: ['a', 'b'], name_suffix: '_Copy' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveCloneGeomVec', '2;1:a1:b', '_Copy', 0)
    expect((await worker.request('live_delete_geom_vec', { geom_ids: ['abc'], clone_delete: 1 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveDeleteGeomVec', '1;3:abc', '', 1)
    expect((await worker.request('live_copy_paste_set', { copy_index: 3, paste_index: 4 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveCopyPasteSet', '', '4', 3)
    expect((await worker.request('live_geom_set_collection', { index: 2 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveGeomSetCollection', '', '', 2)
    engine.call.mockClear()
    expect((await worker.request('live_clone_geom_vec', { geom_ids: [] })).error.outcome).toBe('not_written')
    expect((await worker.request('live_clone_geom_vec', { geom_ids: [''] })).error.outcome).toBe('not_written')
    expect((await worker.request('live_delete_geom_vec', { geom_ids: ['a'], clone_delete: 3 })).error.outcome).toBe('not_written')
    expect((await worker.request('live_parm_set_limits', { parm_id: 'p', values: [1, 2] })).error.outcome).toBe('not_written')
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards geometry display, material and bounding boxes', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_geom_draw_type', { geom_id: 'g' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveGeomDrawType', 'g', '', 0)
    expect((await worker.request('live_geom_set_display_type', { geom_id: 'g', type: 3 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveGeomSetDisplayType', 'g', '', 3)
    expect((await worker.request('live_geom_set_wire_color', { geom_id: 'g', rgb: [1, 2, 3] })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveGeomSetWireColor', 'g', '1\x1f2\x1f3', 0)
    expect((await worker.request('live_geom_set_material', { geom_id: 'g', name: 'Aluminum' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveGeomSetMaterial', 'g', 'Aluminum', 0)
    expect((await worker.request('live_geom_bbox_min', { geom_id: 'g', surf: 1, absolute: false })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveGeomBBoxMin', 'g', '0', 1)
    expect((await worker.request('live_geom_bbox_max', { geom_id: 'g' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveGeomBBoxMax', 'g', '1', 0)
    engine.call.mockClear()
    expect((await worker.request('live_geom_set_draw_type', { geom_id: 'g', type: 1.5 })).error.outcome).toBe('not_written')
    expect((await worker.request('live_geom_set_wire_color', { geom_id: 'g', rgb: [0, 0, 256] })).error.outcome).toBe('not_written')
    expect((await worker.request('live_geom_bbox_min', { geom_id: 'g', surf: 0.5 })).ok).toBe(false)
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards XSec curve metadata and four-value setters', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    expect((await worker.request('live_xsec_alias', { xsec_id: 'x' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveXSecAlias', 'x', '', 0)
    expect((await worker.request('live_xsec_set_curve_alias', { xsec_id: 'x', alias: 'c1' })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveXSecSetCurveAlias', 'x', 'c1', 0)
    expect((await worker.request('live_xsec_set_continuity', { xsec_id: 'x', continuity: 2 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveXSecSetContinuity', 'x', '2', 0)
    expect((await worker.request('live_xsec_tan_angles', { xsec_id: 'x', side: 1 })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveXSecTanAngles', 'x', '', 1)
    expect((await worker.request('live_xsec_set_curvatures', { xsec_id: 'x', side: 0, fields: [0.5, 0.25, 0.75, 1] })).ok).toBe(true)
    expect(engine.call).toHaveBeenLastCalledWith('liveXSecSetCurvatures', 'x', '0\x1f0.5\x1f0.25\x1f0.75\x1f1', 0)
    engine.call.mockClear()
    expect((await worker.request('live_xsec_set_tan_slews', { xsec_id: 'x', side: 0, fields: [1, 2, 3] })).error.outcome).toBe('not_written')
    expect((await worker.request('live_xsec_set_tan_slews', { xsec_id: 'x', side: 0.5, fields: [1, 2, 3, 4] })).error.outcome).toBe('not_written')
    expect((await worker.request('live_xsec_set_continuity', { xsec_id: 'x', continuity: 1.5 })).error.outcome).toBe('not_written')
    expect((await worker.request('live_xsec_set_alias', { xsec_id: 'x', alias: 5 })).error.outcome).toBe('not_written')
    expect(engine.call).not.toHaveBeenCalled()
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
  it('forwards surface queries without losing coordinate precision', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    const u = 0.12345678901234566, w = 0.9876543210987654
    for (const [op, native] of [['live_comp_pnt01', 'liveCompPnt01'], ['live_comp_norm01', 'liveCompNorm01']] as const) {
      engine.call.mockResolvedValueOnce([u, w, -u])
      expect((await worker.request(op, { geom_id: 'g', surf_indx: 1, u, w })).value).toEqual([u, w, -u])
      expect(engine.call).toHaveBeenLastCalledWith(native, 'g', `1,${w}`, u)
    }
    engine.call.mockClear()
    for (const args of [
      { geom_id: '', surf_indx: 0, u, w }, { geom_id: 'g', surf_indx: 1.5, u, w },
      { geom_id: 'g', surf_indx: 2147483648, u, w }, { geom_id: 'g', surf_indx: 0, u: null, w },
      { geom_id: 'g', surf_indx: 0, u, w: '0.5' },
    ]) expect((await worker.request('live_comp_pnt01', args)).ok).toBe(false)
    expect(engine.call).not.toHaveBeenCalled()
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards geometry queries and clipboard edits with write outcome semantics', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    for (const [op, args, native, a, b, value, result] of [
      ['live_geom_types', {}, 'geomTypes', '', '', 0, ['POD']],
      ['live_num_main_surfs', { geom_id: 'g' }, 'liveNumMainSurfs', 'g', '', 0, 1],
      ['live_update_geom', { geom_id: 'g' }, 'liveUpdateGeom', 'g', '', 0, null],
      ['live_set_geom_parent', { geom_id: 'g', parent_id: '' }, 'liveSetGeomParent', 'g', '', 0, null],
      ['live_copy_geom', { geom_id: 'g' }, 'liveCopyGeom', 'g', '', 0, null],
      ['live_cut_geom', { geom_id: 'g', clone_delete: 2 }, 'liveCutGeom', 'g', '', 2, null],
      ['live_paste_geom', { parent: 'p' }, 'livePasteGeom', 'p', '', 0, ['copy']],
      ['live_paste_geom', {}, 'livePasteGeom', '', '', 0, []],
    ] as const) {
      engine.call.mockResolvedValueOnce(result)
      expect((await worker.request(op, args)).value).toEqual(result)
      expect(engine.call).toHaveBeenLastCalledWith(native, a, b, value)
    }
    engine.call.mockClear()
    for (const policy of [-1, 3, 1.5, '1', null, true]) {
      expect((await worker.request('live_cut_geom', { geom_id: 'g', clone_delete: policy })).error.outcome).toBe('not_written')
    }
    expect((await worker.request('live_set_geom_parent', { geom_id: 'g', parent_id: null })).error.outcome).toBe('not_written')
    expect((await worker.request('live_paste_geom', { parent: 3 })).error.outcome).toBe('not_written')
    expect(engine.call).not.toHaveBeenCalled()
    engine.call.mockRejectedValueOnce(new Error('native failure'))
    expect((await worker.request('live_copy_geom', { geom_id: 'g' })).error.outcome).toBe('unknown')
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
      ['live_copy_xsec', { geom_id: 'g', index: 0 }, 'index'],
      ['live_paste_xsec', { geom_id: 'g', index: 0 }, 'index'],
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
  it('forwards native XSec dimensions and validates writes', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    for (const [op, args, native, a, b, value] of [
      ['live_xsec_surf_ids', { geom_id: 'g' }, 'liveXSecSurfIDs', 'g', '', 0],
      ['live_xsec_width', { xsec_id: 'x' }, 'liveXSecWidth', 'x', '', 0],
      ['live_xsec_height', { xsec_id: 'x' }, 'liveXSecHeight', 'x', '', 0],
      ['live_xsec_parm', { xsec_id: 'x', name: 'Width' }, 'liveXSecParm', 'x', 'Width', 0],
      ['live_xsec_set_width', { xsec_id: 'x', width: 2 }, 'liveXSecSetWidth', 'x', '', 2],
      ['live_xsec_set_height', { xsec_id: 'x', height: 3 }, 'liveXSecSetHeight', 'x', '', 3],
      ['live_xsec_set_width_height', { xsec_id: 'x', width: 2, height: 3 }, 'liveXSecSetWidthHeight', 'x', '3', 2],
      ['live_parm_set_by_id', { parm_id: 'p', value: 4 }, 'liveParmSetById', 'p', '', 4],
      ['live_parm_set', { geom_id: 'g', key: 'grp\x1fn', value: 5 }, 'liveParmSet', 'g', 'grp\x1fn', 5],
    ] as const) {
      expect((await worker.request(op, args)).ok).toBe(true)
      expect(engine.call).toHaveBeenLastCalledWith(native, a, b, value)
    }
    engine.call.mockClear()
    for (const [op, args] of [
      ['live_xsec_set_width', { xsec_id: 'x', width: null }],
      ['live_xsec_set_height', { xsec_id: 'x', height: '2' }],
      ['live_xsec_set_width_height', { xsec_id: 'x', width: 2, height: null }],
    ] as const) expect((await worker.request(op, args)).error.outcome).toBe('not_written')
    expect(engine.call).not.toHaveBeenCalled()
    engine.call.mockRejectedValueOnce(new Error('native failure'))
    const error = (await worker.request('live_xsec_set_width', { xsec_id: 'x', width: 2 })).error
    expect(error.outcome).toBe('unknown')
    expect(error.message).toContain('native failure')
    worker.onmessage({ data: { type: 'done', value: 'null' } } as MessageEvent)
  })
  it('forwards XSec clipboard calls and propagates native errors', async () => {
    void runSyncScript('')
    const worker = FakeWorker.instance
    engine.call.mockResolvedValue(null)
    for (const [op, args, native, id, index] of [
      ['live_copy_xsec', { geom_id: 'g', index: 2 }, 'liveCopyXSec', 'g', 2],
      ['live_copy_xsec_by_id', { xsec_id: 'x' }, 'liveCopyXSecByID', 'x', 0],
      ['live_paste_xsec', { geom_id: 'g', index: 3 }, 'livePasteXSec', 'g', 3],
      ['live_paste_xsec_by_id', { xsec_id: 'x' }, 'livePasteXSecByID', 'x', 0],
    ] as const) {
      expect((await worker.request(op, args)).value).toBeNull()
      expect(engine.call).toHaveBeenLastCalledWith(native, id, '', index)
    }
    engine.call.mockRejectedValueOnce(new Error('invalid XSec'))
    expect((await worker.request('live_paste_xsec_by_id', { xsec_id: 'missing' })).error.message).toContain('invalid XSec')
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
