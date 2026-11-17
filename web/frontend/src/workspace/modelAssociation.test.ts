import { beforeEach, describe, expect, it } from 'vitest'
import type { ModelTree } from '../api/types'
import { associateWorkspaceModel, clearWorkspaceModelAssociation, markWorkspaceModelDeleted, reconcileModelAssociation, useModelAssociation } from './modelAssociation'

const model = (overrides: Partial<ModelTree> = {}): ModelTree => ({
  geoms: [], active: [], vehicleId: 'vehicle', fileName: '/work/a.vsp3', version: '', rev: 1,
  modelEpoch: '1', modelEpochValid: true, dirty: false,
  undo: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }, ...overrides,
})

beforeEach(clearWorkspaceModelAssociation)
describe('explicit workspace model association', () => {
  it('does not infer an association from a filename', () => {
    reconcileModelAssociation(model())
    expect(useModelAssociation.getState().status).toBe('none')
  })
  it('retains the model association when its file is deleted', () => {
    associateWorkspaceModel('/work/a.vsp3', model())
    markWorkspaceModelDeleted('/work/other.vsp3')
    expect(useModelAssociation.getState().status).toBe('present')
    markWorkspaceModelDeleted('/work/a.vsp3')
    reconcileModelAssociation(model({ dirty: true }))
    expect(useModelAssociation.getState()).toMatchObject({ path: '/work/a.vsp3', status: 'missing' })
  })
  it('drops association when a new model or filename is observed', () => {
    associateWorkspaceModel('/work/a.vsp3', model())
    reconcileModelAssociation(model({ modelEpoch: '2' }))
    expect(useModelAssociation.getState().status).toBe('none')
    associateWorkspaceModel('/work/a.vsp3', model())
    reconcileModelAssociation(model({ fileName: '/work/b.vsp3' }))
    expect(useModelAssociation.getState().status).toBe('none')
  })
  it('uses the raw path rather than the display filename', () => {
    const snapshot = model({ fileName: 'work/a.vsp3', rawFileName: '/work/a.vsp3' })
    associateWorkspaceModel('/work/a.vsp3', snapshot)
    reconcileModelAssociation(snapshot)
    expect(useModelAssociation.getState().status).toBe('present')
  })
  it('rejects mismatched or unsafe paths', () => {
    associateWorkspaceModel('/work/../a.vsp3', model({ fileName: '/work/../a.vsp3' }))
    expect(useModelAssociation.getState().status).toBe('none')
    associateWorkspaceModel('/work/a.vsp3', model({ fileName: 'Unnamed.vsp3' }))
    expect(useModelAssociation.getState().status).toBe('none')
  })
})
