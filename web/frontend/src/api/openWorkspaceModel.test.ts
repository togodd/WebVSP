import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn(), loadTree: vi.fn(), refitAll: vi.fn(), setState: vi.fn(), associate: vi.fn(), clear: vi.fn(), state: { tree: { geoms: [{ id: 'same' }] }, meshRev: { same: 4 } } }))
vi.mock('../workspace/modelAssociation', () => ({ associateWorkspaceModel: mocks.associate, clearWorkspaceModelAssociation: mocks.clear }))
vi.mock('./wasmEngine', () => ({ openEngineModel: mocks.open }))
vi.mock('../store', () => ({ useStore: { getState: () => ({ ...mocks.state, loadTree: mocks.loadTree, refitAll: mocks.refitAll }), setState: mocks.setState } }))
import { openWorkspaceModel } from './openWorkspaceModel'

beforeEach(() => { vi.clearAllMocks(); mocks.open.mockReset(); mocks.loadTree.mockReset() })

describe('openWorkspaceModel', () => {
  it('opens the engine path, refreshes and invalidates reused mesh IDs', async () => {
    await openWorkspaceModel('/work/nested/model.VSP3')
    expect(mocks.open).toHaveBeenCalledWith('/work/nested/model.VSP3')
    expect(mocks.loadTree).toHaveBeenCalledOnce()
    expect(mocks.setState).toHaveBeenCalledWith({ meshRev: { same: 5 } })
    expect(mocks.refitAll).toHaveBeenCalledOnce()
    expect(mocks.associate).toHaveBeenCalledWith('/work/nested/model.VSP3', mocks.state.tree)
    expect(mocks.clear).not.toHaveBeenCalled()
  })
  it('refreshes and refits after a potentially destructive failure', async () => {
    const failure = new Error('read failed')
    mocks.open.mockRejectedValue(failure)
    await expect(openWorkspaceModel('/work/a.vsp3')).rejects.toBe(failure)
    expect(mocks.loadTree).toHaveBeenCalledOnce()
    expect(mocks.setState).toHaveBeenCalledTimes(2)
    expect(mocks.refitAll).toHaveBeenCalledOnce()
    expect(mocks.clear).toHaveBeenCalledOnce()
    expect(mocks.associate).not.toHaveBeenCalled()
  })
  it('does not report success when refresh fails', async () => {
    mocks.loadTree.mockRejectedValue(new Error('refresh failed'))
    await expect(openWorkspaceModel('/work/a.vsp3')).rejects.toThrow('could not be refreshed')
    expect(mocks.refitAll).toHaveBeenCalledOnce()
  })
  it('preserves both failures', async () => {
    mocks.open.mockRejectedValue(new Error('read'))
    mocks.loadTree.mockRejectedValue(new Error('refresh'))
    await expect(openWorkspaceModel('/work/a.vsp3')).rejects.toBeInstanceOf(AggregateError)
    expect(mocks.refitAll).toHaveBeenCalledOnce()
  })
  it.each(['/work/../a.vsp3', '/work/a/../../b.vsp3', '/other/a.vsp3', '/work/a.txt', '/work/a\\b.vsp3'])('rejects invalid path %s before opening', async path => {
    await expect(openWorkspaceModel(path)).rejects.toThrow('Expected a VSP3')
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
