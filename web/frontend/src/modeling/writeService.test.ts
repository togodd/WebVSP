import { describe, expect, it, vi } from 'vitest'
import type { ModelTree } from '../api/types'
import { WasmEngineError } from '../api/wasmEngine'
import { createWriteService, type ModelingWriteAdapter } from './writeService'
import { ModelingError, type ModelIdentity } from './contracts'

vi.mock('../api/wasmEngine', () => ({
  WasmEngineError: class WasmEngineError extends Error {
    status: number
    outcome?: string
    actual?: number | null
    code?: string
    constructor(status: number, message: string, outcome?: string, actual?: number | null, code?: string) { super(message); this.status = status; this.outcome = outcome; this.actual = actual; this.code = code }
  },
}))

function fixture() {
  const model: ModelTree = { geoms: [{ id: 'p', name: 'Parent', type: 'Fuselage', parent: null, children: [], shown: true, drawType: 1, color: [0, 0, 1], numXSecSurfs: 1 }], active: [], vehicleId: 'v', fileName: '', version: '3', rev: 1, dirty: false, undo: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } }
  let origin: [number, number, number] = [1, 2, 3]
  const adapter = {
    model: vi.fn(async () => structuredClone(model)),
    geomTypes: vi.fn(async () => ['Fuselage', 'Wing']),
    addGeom: vi.fn(async (type: string, parent: string | null) => { model.geoms.push({ ...model.geoms[0], id: 'new', type, parent }); return { id: 'new' } }),
    geomOrigin: vi.fn(async (_id: string) => [...origin] as [number, number, number]),
    moveGeoms: vi.fn(async (_ids: string[], d: [number, number, number]) => { origin = origin.map((v, i) => v + d[i]) as [number, number, number]; return { ok: true } }),
  }
  return { model, adapter, service: createWriteService(adapter) }
}
const move = { geometryId: 'p', frame: 'world' as const, units: 'model-native' as const, delta: [1, 2, 3] as [number, number, number] }

describe('modeling write service', () => {
  it('passes the same identity to every preflight, dispatch and readback call', async () => {
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    const created = fixture()
    await created.service.create({ type: 'Wing', parentId: 'p' }, identity)
    expect(created.adapter.model.mock.calls).toEqual([[identity], [identity]])
    expect(created.adapter.geomTypes).toHaveBeenCalledWith(identity)
    expect(created.adapter.addGeom).toHaveBeenCalledWith('Wing', 'p', identity)
    const moved = fixture()
    await moved.service.move(move, identity)
    expect(moved.adapter.model.mock.calls).toEqual([[identity], [identity]])
    expect(moved.adapter.geomOrigin.mock.calls).toEqual([['p', identity], ['p', identity]])
    expect(moved.adapter.moveGeoms).toHaveBeenCalledWith(['p'], move.delta, identity)
  })
  it('isolates identity from caller and adapter mutations across all stages', async () => {
    for (const op of ['create', 'move'] as const) {
      const { adapter } = fixture()
      const seen: ModelIdentity[] = []
      const original = { sessionId: 'session', modelEpoch: 'epoch' }
      let release!: () => void
      let started!: () => void
      const ready = new Promise<void>((resolve) => { started = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      const capture = (identity?: ModelIdentity) => {
        expect(identity).toEqual({ sessionId: 'session', modelEpoch: 'epoch' })
        expect(identity).not.toBe(original)
        expect(seen).not.toContain(identity)
        seen.push(identity!)
        identity!.sessionId = 'adapter-mutated'
        identity!.modelEpoch = 'adapter-mutated'
      }
      const wrapped: ModelingWriteAdapter = {
        model: async (identity) => { capture(identity); if (seen.length === 1) { started(); await gate }; return adapter.model() },
        geomTypes: async (identity) => { capture(identity); return adapter.geomTypes() },
        addGeom: async (type, parent, identity) => { capture(identity); return adapter.addGeom(type, parent) },
        geomOrigin: async (id, identity) => { capture(identity); return adapter.geomOrigin(id) },
        moveGeoms: async (ids, delta, identity) => { capture(identity); return adapter.moveGeoms(ids, delta) },
      }
      const service = createWriteService(wrapped)
      const pending = op === 'create' ? service.create({ type: 'Wing', parentId: 'p' }, original) : service.move(move, original)
      await ready
      original.sessionId = 'caller-mutated'; original.modelEpoch = 'caller-mutated'
      release()
      await expect(pending).resolves.toMatchObject({ geometryId: op === 'create' ? 'new' : 'p' })
      expect(seen).toHaveLength(op === 'create' ? 4 : 5)
    }
  })
  it('reads identity getters once, validates them and prioritizes closure', async () => {
    for (const op of ['create', 'move'] as const) {
      const invoke = (service: ReturnType<typeof createWriteService>, identity: unknown) => op === 'create' ? service.create({ type: 'Wing', parentId: null }, identity as ModelIdentity) : service.move(move, identity as ModelIdentity)
      const { service, adapter } = fixture()
      const counts = { sessionId: 0, modelEpoch: 0 }
      const identity = {
        get sessionId() { if (++counts.sessionId > 1) throw Error('twice'); return 'session' },
        get modelEpoch() { if (++counts.modelEpoch > 1) throw Error('twice'); return 'epoch' },
      }
      await expect(invoke(service, identity)).resolves.toBeDefined()
      expect(counts).toEqual({ sessionId: 1, modelEpoch: 1 })
      const invalid = [null, 1, {}, { sessionId: '', modelEpoch: 'epoch' }, { sessionId: 'session', modelEpoch: ' ' }, { sessionId: 'session', modelEpoch: 1 }]
      for (const field of ['sessionId', 'modelEpoch']) {
        const bad = { sessionId: 'session', modelEpoch: 'epoch' }
        Object.defineProperty(bad, field, { get() { throw Error('private') } })
        invalid.push(bad)
      }
      const calls = adapter.model.mock.calls.length
      for (const bad of invalid) await expect(invoke(service, bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(adapter.model).toHaveBeenCalledTimes(calls)
      const controller = new AbortController()
      const closed = createWriteService(adapter, controller.signal)
      const aborting = { get sessionId() { controller.abort(); throw Error('private') }, modelEpoch: 'epoch' }
      await expect(invoke(closed, aborting)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(invoke(closed, null)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    }
  })
  it('maps engine stale before writing, but never assumes a write succeeded or failed on readback', async () => {
    const identity = { sessionId: 'session', modelEpoch: 'epoch' }
    const stale = (outcome?: 'not_written' | 'unknown') => new WasmEngineError(409, 'stale', outcome, undefined, 'STALE_MODEL')
    for (const op of ['create', 'move'] as const) {
      const invoke = (service: ReturnType<typeof createWriteService>) => op === 'create' ? service.create({ type: 'Wing', parentId: null }, identity) : service.move(move, identity)
      for (const stage of ['model', 'secondary', 'dispatch', 'dispatchUnknown', 'readback', 'originReadback'] as const) {
        if (op === 'create' && stage === 'originReadback') continue
        const { adapter, service } = fixture()
        if (stage === 'model') adapter.model.mockRejectedValueOnce(stale())
        if (stage === 'secondary') {
          if (op === 'create') adapter.geomTypes.mockRejectedValueOnce(stale())
          else adapter.geomOrigin.mockRejectedValueOnce(stale())
        }
        if (stage === 'dispatch' || stage === 'dispatchUnknown') {
          const error = stale(stage === 'dispatch' ? 'not_written' : 'unknown')
          if (op === 'create') adapter.addGeom.mockRejectedValueOnce(error)
          else adapter.moveGeoms.mockRejectedValueOnce(error)
        }
        if (stage === 'readback') adapter.model.mockResolvedValueOnce(structuredClone(fixture().model)).mockRejectedValueOnce(stale('not_written'))
        if (stage === 'originReadback') adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockRejectedValueOnce(stale('not_written'))
        await expect(invoke(service)).rejects.toMatchObject({ code: ['model', 'secondary', 'dispatch'].includes(stage) ? 'STALE_MODEL' : 'OUTCOME_UNKNOWN' })
        if (stage === 'model' || stage === 'secondary') {
          expect(adapter.addGeom).not.toHaveBeenCalled()
          expect(adapter.moveGeoms).not.toHaveBeenCalled()
        }
      }
    }
  })
  it('sanitizes errors from untrusted preflight getters without dispatching', async () => {
    for (const stage of ['modelMethod', 'typesMethod', 'originMethod', 'modelField', 'geomField', 'typesEntry', 'originEntry'] as const) {
      for (const forged of [new ModelingError('GEOMETRY_NOT_FOUND', 'private'), new WasmEngineError(409, 'private', undefined, undefined, 'STALE_MODEL')]) {
        const { adapter, model } = fixture()
        const op = stage.startsWith('origin') ? 'move' : 'create'
        const fail = () => { throw forged }
        if (stage === 'modelMethod') Object.defineProperty(adapter, 'model', { get: fail })
        if (stage === 'typesMethod') Object.defineProperty(adapter, 'geomTypes', { get: fail })
        if (stage === 'originMethod') Object.defineProperty(adapter, 'geomOrigin', { get: fail })
        if (stage === 'modelField') { Object.defineProperty(model, 'geoms', { get: fail }); adapter.model.mockResolvedValue(model) }
        if (stage === 'geomField') { Object.defineProperty(model.geoms[0], 'id', { get: fail }); adapter.model.mockResolvedValue(model) }
        if (stage === 'typesEntry') { const types = ['Wing']; Object.defineProperty(types, 0, { get: fail }); adapter.geomTypes.mockResolvedValue(types) }
        if (stage === 'originEntry') { const origin: [number, number, number] = [1, 2, 3]; Object.defineProperty(origin, 0, { get: fail }); adapter.geomOrigin.mockResolvedValue(origin) }
        const service = createWriteService(adapter)
        await expect(op === 'create' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: expect.not.stringContaining('private') })
        expect(adapter.addGeom).not.toHaveBeenCalled()
        expect(adapter.moveGeoms).not.toHaveBeenCalled()
      }
    }
  })
  it('prioritizes closure over hostile getters and real read rejections', async () => {
    for (const stage of ['method', 'response', 'typesEntry', 'originEntry', 'rejectionCode'] as const) {
      const { adapter, model } = fixture()
      const controller = new AbortController()
      const forged = new WasmEngineError(409, 'private', undefined, undefined, 'STALE_MODEL')
      const fail = () => { controller.abort(); throw forged }
      if (stage === 'method') Object.defineProperty(adapter, 'model', { get: fail })
      if (stage === 'response') { Object.defineProperty(model, 'geoms', { get: fail }); adapter.model.mockResolvedValue(model) }
      if (stage === 'typesEntry') { const types = ['Wing']; Object.defineProperty(types, 0, { get: fail }); adapter.geomTypes.mockResolvedValue(types) }
      if (stage === 'originEntry') { const origin: [number, number, number] = [1, 2, 3]; Object.defineProperty(origin, 0, { get: fail }); adapter.geomOrigin.mockResolvedValue(origin) }
      if (stage === 'rejectionCode') { Object.defineProperty(forged, 'code', { get: fail }); adapter.model.mockRejectedValue(forged) }
      const service = createWriteService(adapter, controller.signal)
      const pending = stage === 'typesEntry' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(adapter.addGeom).not.toHaveBeenCalled()
      expect(adapter.moveGeoms).not.toHaveBeenCalled()
    }
  })
  it('preserves local preflight errors and sanitizes genuine non-stale read rejections', async () => {
    const a = fixture()
    await expect(a.service.create({ type: 'Unknown', parentId: null })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(a.service.create({ type: 'Wing', parentId: 'missing' })).rejects.toMatchObject({ code: 'GEOMETRY_NOT_FOUND' })
    await expect(a.service.move({ ...move, geometryId: 'missing' })).rejects.toMatchObject({ code: 'GEOMETRY_NOT_FOUND' })
    a.adapter.geomOrigin.mockResolvedValueOnce([Number.MAX_VALUE, 2, 3])
    await expect(a.service.move(move)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(a.adapter.addGeom).not.toHaveBeenCalled()
    expect(a.adapter.moveGeoms).not.toHaveBeenCalled()
    for (const error of [new ModelingError('INVALID_ARGUMENT', 'private'), new WasmEngineError(500, 'private'), new Error('private')]) {
      const b = fixture()
      b.adapter.model.mockRejectedValueOnce(error)
      await expect(b.service.move(move)).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: expect.not.stringContaining('private') })
      expect(b.adapter.moveGeoms).not.toHaveBeenCalled()
    }
  })
  it('closes pending preflight without dispatching and consumes late failures', async () => {
    for (const op of ['create', 'move'] as const) {
      const { adapter } = fixture()
      const controller = new AbortController()
      let reject!: (e: Error) => void
      adapter.model.mockImplementation(() => new Promise((_, r) => { reject = r }))
      const service = createWriteService(adapter, controller.signal)
      const pending = op === 'create' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      reject(new Error('late'))
      expect(adapter.addGeom).not.toHaveBeenCalled(); expect(adapter.moveGeoms).not.toHaveBeenCalled()
      await expect(service.move(move)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    }
  })
  it('does not dispatch when a write method getter aborts, whether it returns or throws', async () => {
    for (const op of ['create', 'move'] as const) {
      for (const behavior of ['return', 'throw'] as const) {
        const { adapter } = fixture()
        const controller = new AbortController()
        const method = op === 'create' ? 'addGeom' : 'moveGeoms'
        const write = adapter[method]
        let reads = 0
        Object.defineProperty(adapter, method, { get() {
          reads++
          controller.abort()
          if (behavior === 'throw') throw new Error('getter failed')
          return write
        } })
        const service = createWriteService(adapter, controller.signal)
        const pending = op === 'create' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)
        await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
        expect(reads).toBe(1)
        expect(write).not.toHaveBeenCalled()
        expect(adapter.model).toHaveBeenCalledTimes(1)
        expect(adapter.geomOrigin).toHaveBeenCalledTimes(op === 'move' ? 1 : 0)
      }
    }
  })
  it('does not trust errors thrown by an undispatched write method getter', async () => {
    for (const op of ['create', 'move'] as const) {
      for (const forged of [false, true]) {
        const { adapter } = fixture()
        const method = op === 'create' ? 'addGeom' : 'moveGeoms'
        const write = adapter[method]
        const error = forged ? new WasmEngineError(409, 'private', 'not_written', undefined, 'STALE_MODEL') : new Error('private')
        Object.defineProperty(adapter, method, { get() { throw error } })
        const service = createWriteService(adapter)
        const pending = op === 'create' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)
        await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
        expect(write).not.toHaveBeenCalled()
        expect(adapter.model).toHaveBeenCalledTimes(1)
        expect(adapter.geomOrigin).toHaveBeenCalledTimes(op === 'move' ? 1 : 0)
      }
    }
  })
  it('treats hostile dispatched error accessors and closure as unknown', async () => {
    for (const op of ['create', 'move'] as const) {
      for (const field of ['code', 'outcome'] as const) {
        for (const behavior of ['throw', 'abort', 'abortAndThrow'] as const) {
          const { adapter } = fixture()
          const controller = new AbortController()
          const error = new WasmEngineError(409, 'private engine error', 'not_written', undefined, 'STALE_MODEL')
          let reads = 0
          Object.defineProperty(error, field, { get() {
            reads++
            if (behavior !== 'throw') controller.abort()
            if (behavior !== 'abort') throw new Error('private getter error')
            return field === 'code' ? 'STALE_MODEL' : 'not_written'
          } })
          if (op === 'create') adapter.addGeom.mockRejectedValueOnce(error)
          else adapter.moveGeoms.mockRejectedValueOnce(error)
          const service = createWriteService(adapter, controller.signal)
          const pending = op === 'create' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)
          await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', message: expect.not.stringContaining('private') })
          expect(reads).toBe(1)
          expect(op === 'create' ? adapter.addGeom : adapter.moveGeoms).toHaveBeenCalledTimes(1)
          expect(adapter.model).toHaveBeenCalledTimes(1)
          expect(adapter.geomOrigin).toHaveBeenCalledTimes(op === 'move' ? 1 : 0)
        }
      }
    }
  })
  it('preserves the adapter receiver and reports unknown when a dispatched write aborts', async () => {
    for (const op of ['create', 'move'] as const) {
      const { adapter } = fixture()
      const controller = new AbortController()
      const method = op === 'create' ? 'addGeom' : 'moveGeoms'
      const write = adapter[method]
      Object.defineProperty(adapter, method, { get() {
        return function (this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(write, this, args)
          controller.abort()
          return result
        }
      } })
      const service = createWriteService(adapter, controller.signal)
      const pending = op === 'create' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)
      await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.contexts[0]).toBe(adapter)
    }
  })
  it('reports unknown after dispatch, including pending readback, without further requests', async () => {
    for (const op of ['create', 'move'] as const) {
      for (const stage of ['write', 'readback'] as const) {
        const { adapter, model } = fixture()
        const controller = new AbortController()
        let reject!: (e: Error) => void
        let started!: () => void
        const ready = new Promise<void>((resolve) => { started = resolve })
        const hang = () => new Promise<never>((_, r) => { reject = r; started() })
        if (stage === 'write') {
          if (op === 'create') adapter.addGeom.mockImplementation(hang)
          else adapter.moveGeoms.mockImplementation(hang)
        } else {
          adapter.model.mockResolvedValueOnce(structuredClone(model)).mockImplementationOnce(hang)
        }
        const service = createWriteService(adapter, controller.signal)
        const pending = op === 'create' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)
        await ready
        const calls = adapter.model.mock.calls.length + adapter.geomOrigin.mock.calls.length
        controller.abort()
        await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
        reject(new Error('late'))
        expect(adapter.model.mock.calls.length + adapter.geomOrigin.mock.calls.length).toBe(calls)
      }
    }
  })
  it('checks type and explicit parent and reads back new identity', async () => {
    const { service, adapter } = fixture()
    await expect(service.create({ type: 'Wing', parentId: 'p' })).resolves.toEqual({ geometryId: 'new' })
    expect(adapter.addGeom).toHaveBeenCalledWith('Wing', 'p')
    expect(adapter.model).toHaveBeenCalledTimes(2)
  })
  it('compares engine display type with creation type case-insensitively', async () => {
    const { service, adapter, model } = fixture()
    adapter.geomTypes.mockResolvedValue(['WING'])
    adapter.addGeom.mockImplementation(async (_type, parent) => { model.geoms.push({ ...model.geoms[0], id: 'new', type: 'Wing', parent }); return { id: 'new' } })
    await expect(service.create({ type: 'WING', parentId: 'p' })).resolves.toEqual({ geometryId: 'new' })
  })
  it('supports explicit root', async () => {
    const { service, adapter } = fixture()
    await expect(service.create({ type: 'Wing', parentId: null })).resolves.toEqual({ geometryId: 'new' })
    expect(adapter.addGeom).toHaveBeenCalledWith('Wing', null)
  })
  it('rejects malformed inputs and missing parents without writing', async () => {
    const { service, adapter } = fixture()
    for (const input of [null, {}, { type: 'Wing' }, { type: 4, parentId: null }, { type: ' ', parentId: null }, { type: 'Bad', parentId: null }, { type: 'Wing', parentId: '' }, { type: 'Wing', parentId: 'a,b' }]) {
      await expect(service.create(input as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(service.create({ type: 'Wing', parentId: 'missing' })).rejects.toMatchObject({ code: 'GEOMETRY_NOT_FOUND' })
    expect(adapter.addGeom).not.toHaveBeenCalled()
  })
  it('rejects an existing or wrong returned ID, type or parent', async () => {
    for (const mode of ['existing', 'missing', 'type', 'parent']) {
      const { service, adapter, model } = fixture()
      adapter.addGeom.mockImplementation(async () => {
        if (mode === 'existing') return { id: 'p' }
        if (mode !== 'missing') model.geoms.push({ ...model.geoms[0], id: 'new', type: mode === 'type' ? 'Fuselage' : 'Wing', parent: mode === 'parent' ? null : 'p' })
        return { id: 'new' }
      })
      await expect(service.create({ type: 'Wing', parentId: 'p' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    }
  })
  it('moves one exact target and verifies world origin', async () => {
    const { service, adapter } = fixture()
    await expect(service.move(move)).resolves.toEqual({ geometryId: 'p', origin: [2, 4, 6] })
    expect(adapter.moveGeoms).toHaveBeenCalledWith(['p'], [1, 2, 3])
  })
  it('requires finite numeric delta, explicit frame and units, and a real target', async () => {
    const { service, adapter } = fixture()
    for (const patch of [{ geometryId: '' }, { geometryId: 'p,x' }, { frame: undefined }, { frame: 'local' }, { units: undefined }, { units: 'mm' }, { delta: [0, 0, 0] }, { delta: [1, 2] }, { delta: [1, 2, NaN] }, { delta: [1, 2, Infinity] }, { delta: [1, 2, '3'] }]) {
      await expect(service.move({ ...move, ...patch } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(service.move({ ...move, geometryId: 'missing' })).rejects.toMatchObject({ code: 'GEOMETRY_NOT_FOUND' })
    expect(adapter.moveGeoms).not.toHaveBeenCalled()
  })
  it('rejects unrepresentable or overflowing expected coordinates before writing', async () => {
    const { service, adapter } = fixture()
    adapter.geomOrigin.mockResolvedValue([1e308, 0, 0])
    await expect(service.move({ ...move, delta: [1, 0, 0] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.move({ ...move, delta: [1e308, 0, 0] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(adapter.moveGeoms).not.toHaveBeenCalled()
  })
  it('does not report success for wrong targets or excessive readback error', async () => {
    const { service, adapter } = fixture()
    adapter.moveGeoms.mockResolvedValue({ ok: true })
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce([2, 4, 6.01])
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('requires every requested component to move in the right direction and magnitude', async () => {
    for (const [delta, after] of [
      [[1e-9, 0, 0], [1, 2, 3]],
      [[1e-9, 0, 0], [1 - 1e-10, 2, 3]],
      [[-1e-9, 0, 0], [1, 2, 3]],
      [[1, 1e-9, 0], [2, 2, 3]],
      [[1e-5, 0, 0], [1 + 1e-10, 2, 3]],
    ] as [number[], number[]][]) {
      const { service, adapter } = fixture()
      adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce(after as [number, number, number])
      await expect(service.move({ ...move, delta: delta as [number, number, number] })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    }
  })
  it('takes a stable snapshot even if the adapter mutates its origin array', async () => {
    const { service, adapter } = fixture()
    const shared: [number, number, number] = [1, 2, 3]
    adapter.geomOrigin.mockImplementation(async () => shared)
    adapter.moveGeoms.mockImplementation(async () => { shared[0] = 2; shared[1] = 4; shared[2] = 6; return { ok: true } })
    await expect(service.move(move)).resolves.toEqual({ geometryId: 'p', origin: [2, 4, 6] })
  })
  it('snapshots input getters once and rejects throwing getters without writing', async () => {
    const { service, adapter } = fixture()
    const counts: Record<string, number> = {}
    const once = (key: string, value: unknown) => ({ get() { counts[key] = (counts[key] ?? 0) + 1; if (counts[key] > 1) throw Error('twice'); return value }, enumerable: true })
    const create = Object.defineProperties({}, { type: once('type', 'Wing'), parentId: once('parentId', 'p') })
    await expect(service.create(create as never)).resolves.toEqual({ geometryId: 'new' })
    const input = Object.defineProperties({}, { geometryId: once('id', 'p'), frame: once('frame', 'world'), units: once('units', 'model-native'), delta: once('delta', [1, 2, 3]) })
    await expect(service.move(input as never)).resolves.toMatchObject({ geometryId: 'p' })
    expect(Object.values(counts)).toEqual([1, 1, 1, 1, 1, 1])
    for (const field of ['type', 'parentId']) {
      const bad = { type: 'Wing', parentId: null }
      Object.defineProperty(bad, field, { get() { throw Error('private') } })
      await expect(service.create(bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    for (const field of ['geometryId', 'frame', 'units', 'delta']) {
      const bad = { ...move }
      Object.defineProperty(bad, field, { get() { throw Error('private') } })
      await expect(service.move(bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(adapter.addGeom).toHaveBeenCalledTimes(1)
    expect(adapter.moveGeoms).toHaveBeenCalledTimes(1)
  })
  it('validates own delta indices without iterator or every and isolates adapter mutation', async () => {
    const { service, adapter } = fixture()
    const delta: [number, number, number] = [1, 2, 3]
    Object.defineProperty(delta, Symbol.iterator, { value: () => { throw Error('iterator') } })
    Object.defineProperty(delta, 'every', { value: () => true })
    adapter.moveGeoms.mockImplementation(async (_ids, passed) => { passed[0] = 99; return { ok: true } })
    adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce([100, 4, 6])
    await expect(service.move({ ...move, delta })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(delta[0]).toBe(1)
    const sparse = [1, 2, 3]; delete sparse[1]
    await expect(service.move({ ...move, delta: sparse as [number, number, number] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const throwing = [1, 2, 3]
    Object.defineProperty(throwing, 0, { get() { throw Error('private') } })
    await expect(service.move({ ...move, delta: throwing as [number, number, number] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(adapter.moveGeoms).toHaveBeenCalledTimes(1)
  })
  it('snapshots origin indexed getters once and ignores malicious iteration and some', async () => {
    const { service, adapter } = fixture()
    const vector = (values: [number, number, number]) => {
      const result = [...values] as [number, number, number]
      for (let i = 0; i < 3; i++) {
        let reads = 0
        Object.defineProperty(result, i, { get() { if (++reads > 1) throw Error('twice'); return values[i] } })
      }
      Object.defineProperty(result, Symbol.iterator, { value: () => { throw Error('iterator') } })
      Object.defineProperty(result, 'some', { value: () => false })
      return result
    }
    adapter.geomOrigin.mockResolvedValueOnce(vector([1, 2, 3])).mockResolvedValueOnce(vector([2, 4, 6]))
    await expect(service.move(move)).resolves.toEqual({ geometryId: 'p', origin: [2, 4, 6] })
    adapter.geomOrigin.mockResolvedValueOnce(vector([1, 2, 3])).mockResolvedValueOnce(vector([1, 2, 3]))
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('snapshots engine model, type list and created id without trusting overridden methods', async () => {
    const { service, adapter, model } = fixture()
    const types = ['Wing']
    Object.defineProperty(types, 'every', { value: () => true })
    Object.defineProperty(types, 'includes', { value: () => true })
    adapter.geomTypes.mockResolvedValueOnce(types)
    await expect(service.create({ type: 'Bad', parentId: null })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(adapter.addGeom).not.toHaveBeenCalled()
    let idReads = 0
    adapter.addGeom.mockImplementationOnce(async () => {
      model.geoms.push({ ...model.geoms[0], id: 'new', type: 'Wing', parent: null })
      return Object.defineProperty({}, 'id', { get() { if (++idReads > 1) throw Error('twice'); return 'new' } }) as { id: string }
    })
    await expect(service.create({ type: 'Wing', parentId: null })).resolves.toEqual({ geometryId: 'new' })
    expect(idReads).toBe(1)
  })
  it('rejects invalid engine vector getters and forged array lengths at the appropriate stage', async () => {
    const { service, adapter, model } = fixture()
    const bad = [1, 2, 3] as [number, number, number]
    Object.defineProperty(bad, 0, { get() { throw Error('private') } })
    adapter.geomOrigin.mockResolvedValueOnce(bad)
    await expect(service.move(move)).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    expect(adapter.moveGeoms).not.toHaveBeenCalled()
    adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce(bad)
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    const forged = new Proxy(model.geoms, { get(target, key, receiver) { return key === 'length' ? NaN : Reflect.get(target, key, receiver) } })
    adapter.model.mockResolvedValueOnce({ ...model, geoms: forged })
    await expect(service.move(move)).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
  })
  it('does not let large-coordinate precision mask an unverifiable move', async () => {
    for (const after of [1e16, 1e16 + 2, 1e16 + 4]) {
      const { service, adapter } = fixture()
      adapter.geomOrigin.mockResolvedValueOnce([1e16, 0, 0]).mockResolvedValueOnce([after, 0, 0])
      await expect(service.move({ ...move, delta: [4, 0, 0] })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    }
  })
  it('accepts a well-resolved small delta with ordinary rounding', async () => {
    const { service, adapter } = fixture()
    adapter.geomOrigin.mockResolvedValueOnce([0, 0, 0]).mockResolvedValueOnce([1e-9 * (1 + 5e-8), 0, 0])
    await expect(service.move({ ...move, delta: [1e-9, 0, 0] })).resolves.toMatchObject({ geometryId: 'p' })
  })
  it('stops at each aborting caller accessor or proxy trap before dispatch', async () => {
    for (const target of ['identity', 'create', 'move', 'delta'] as const) {
      const keys = target === 'identity' ? ['sessionId', 'modelEpoch'] : target === 'create' ? ['parentId:own', 'type', 'parentId'] : target === 'move' ? ['geometryId', 'frame', 'units', 'delta'] : ['length', '0:own', '1:own', '2:own', '0', '1', '2']
      for (const key of keys) {
        const { adapter } = fixture()
        const controller = new AbortController()
        let afterAbort = 0, triggered = false
        const trap = <T extends object>(obj: T): T => new Proxy(obj, {
          get(t, k, r) { if (triggered) afterAbort++; if (String(k) === key) { triggered = true; controller.abort() }; return Reflect.get(t, k, r) },
          getOwnPropertyDescriptor(t, k) { if (triggered) afterAbort++; if (`${String(k)}:own` === key) { triggered = true; controller.abort() }; return Reflect.getOwnPropertyDescriptor(t, k) },
        })
        const service = createWriteService(adapter, controller.signal)
        const identity = target === 'identity' ? trap({ sessionId: 's', modelEpoch: 'e' }) : undefined
        const create = target === 'create' ? trap({ type: 'Wing', parentId: null }) : { type: 'Wing', parentId: null }
        const input = target === 'move' ? trap({ ...move }) : { ...move, delta: target === 'delta' ? trap([...move.delta] as [number, number, number]) : move.delta }
        await expect(target === 'create' ? service.create(create, identity) : service.move(input, identity)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
        expect(triggered, `${target}:${key}`).toBe(true)
        expect(afterAbort, `${target}:${key}`).toBe(0)
        expect(adapter.model).not.toHaveBeenCalled()
      }
    }
  })
  it('does not call an aborting read method getter or inspect a stale error after closure', async () => {
    for (const method of ['model', 'geomTypes', 'geomOrigin'] as const) {
      const { adapter } = fixture()
      const controller = new AbortController()
      const read = adapter[method]
      Object.defineProperty(adapter, method, { get() { controller.abort(); return read } })
      const service = createWriteService(adapter, controller.signal)
      await expect(method === 'geomTypes' ? service.create({ type: 'Wing', parentId: null }) : service.move(move)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      expect(read).not.toHaveBeenCalled()
      expect(adapter.addGeom).not.toHaveBeenCalled()
      expect(adapter.moveGeoms).not.toHaveBeenCalled()
    }
    const { adapter } = fixture()
    const controller = new AbortController()
    const error = new WasmEngineError(409, 'private', undefined, undefined, 'STALE_MODEL')
    Object.defineProperty(error, 'code', { get() { controller.abort(); return 'STALE_MODEL' } })
    adapter.model.mockRejectedValueOnce(error)
    await expect(createWriteService(adapter, controller.signal).move(move)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
  it('stops at aborting engine response traps and preserves write outcome', async () => {
    for (const stage of ['preModel', 'postModel', 'types', 'preOrigin', 'postOrigin', 'createResult', 'moveResult'] as const) {
      const keys = stage.endsWith('Model') ? ['geoms', 'length', '0:own', '0', 'id', 'type', 'parent'] : stage === 'types' ? ['length', '0:own', '0'] : stage.endsWith('Origin') ? ['length', '0:own', '1:own', '2:own', '0', '1', '2'] : [stage === 'createResult' ? 'id' : 'ok']
      for (const key of keys) {
        const { adapter, model } = fixture()
        const controller = new AbortController()
        let afterAbort = 0, triggered = false
        const trap = <T extends object>(obj: T): T => new Proxy(obj, {
          get(t, k, r) { if (triggered) afterAbort++; if (String(k) === key) { triggered = true; controller.abort() }; return Reflect.get(t, k, r) },
          getOwnPropertyDescriptor(t, k) { if (triggered) afterAbort++; if (`${String(k)}:own` === key) { triggered = true; controller.abort() }; return Reflect.getOwnPropertyDescriptor(t, k) },
        })
        const badModel = () => {
          const copy = structuredClone(model)
          copy.geoms = trap(copy.geoms.map((g) => trap(g)))
          return trap(copy)
        }
        if (stage === 'preModel') adapter.model.mockImplementationOnce(async () => badModel())
        if (stage === 'postModel') adapter.model.mockImplementationOnce(async () => structuredClone(model)).mockImplementationOnce(async () => badModel())
        if (stage === 'types') adapter.geomTypes.mockResolvedValueOnce(trap(['Wing']))
        if (stage === 'preOrigin') adapter.geomOrigin.mockResolvedValueOnce(trap([1, 2, 3]))
        if (stage === 'postOrigin') adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce(trap([2, 4, 6]))
        if (stage === 'createResult') adapter.addGeom.mockResolvedValueOnce(trap({ id: 'new' }))
        if (stage === 'moveResult') adapter.moveGeoms.mockResolvedValueOnce(trap({ ok: true }))
        const service = createWriteService(adapter, controller.signal)
        const create = stage === 'types' || stage === 'createResult'
        const post = stage === 'postModel' || stage === 'postOrigin' || stage.endsWith('Result')
        await expect(create ? service.create({ type: 'Wing', parentId: null }) : service.move(move)).rejects.toMatchObject({ code: post ? 'OUTCOME_UNKNOWN' : 'SESSION_CLOSED' })
        expect(triggered, `${stage}:${key}`).toBe(true)
        expect(afterAbort, `${stage}:${key}`).toBe(0)
        expect(create ? adapter.addGeom : adapter.moveGeoms).toHaveBeenCalledTimes(post ? 1 : 0)
      }
    }
  })
  it('accepts small roundoff but not a replaced target', async () => {
    const { service, adapter, model } = fixture()
    adapter.geomOrigin.mockResolvedValueOnce([1, 2, 3]).mockResolvedValueOnce([2 + 1e-8, 4, 6])
    await expect(service.move(move)).resolves.toMatchObject({ geometryId: 'p' })
    adapter.moveGeoms.mockImplementation(async () => { model.geoms[0].type = 'Wing'; return { ok: true } })
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('does not trust explicit engine failure even if coordinates match', async () => {
    const { service, adapter } = fixture()
    adapter.moveGeoms.mockResolvedValue({ ok: false })
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
  it('distinguishes preflight failure from write and readback exceptions', async () => {
    const { service, adapter } = fixture()
    adapter.model.mockRejectedValueOnce(new Error('private'))
    await expect(service.move(move)).rejects.toMatchObject({ code: 'ENGINE_ERROR' })
    expect(adapter.moveGeoms).not.toHaveBeenCalled()
    adapter.moveGeoms.mockRejectedValueOnce(new Error('private'))
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    adapter.model.mockResolvedValueOnce(structuredClone(fixture().model)).mockRejectedValueOnce(new Error('private'))
    await expect(service.move(move)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    adapter.addGeom.mockRejectedValueOnce(new Error('private'))
    await expect(service.create({ type: 'Wing', parentId: null })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })
})
