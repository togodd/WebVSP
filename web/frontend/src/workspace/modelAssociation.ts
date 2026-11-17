// A workspace association is established only by a successful explicit open, not
// by the model's display name (which scripts can change without saving).
import { create } from 'zustand'
import type { ModelTree } from '../api/types'

export type AssociationStatus = 'none' | 'present' | 'missing'
interface AssociationState {
  path: string | null
  status: AssociationStatus
  epoch: string | null
  vehicleId: string | null
}

export const useModelAssociation = create<AssociationState>(() => ({
  path: null, status: 'none', epoch: null, vehicleId: null,
}))

/** Called after a successful explicit workspace open and a fresh model snapshot. */
export function associateWorkspaceModel(path: string, model: ModelTree): void {
  // Reject ambiguous, non-canonical and non-workspace paths.
  if (!path.startsWith('/work/') || path.split('/').some((p) => p === '.' || p === '..') || path.includes('//') || (model.rawFileName ?? model.fileName) !== path) {
    clearWorkspaceModelAssociation()
    return
  }
  useModelAssociation.setState({ path, status: 'present', epoch: model.modelEpochValid && model.modelEpoch ? model.modelEpoch : null, vehicleId: model.vehicleId })
}

export function clearWorkspaceModelAssociation(): void {
  useModelAssociation.setState({ path: null, status: 'none', epoch: null, vehicleId: null })
}

/** Drop a stale association when a different model or filename is observed. */
export function reconcileModelAssociation(model: ModelTree): void {
  const state = useModelAssociation.getState()
  if (!state.path) return
  if ((model.rawFileName ?? model.fileName) !== state.path || model.vehicleId !== state.vehicleId ||
      (state.epoch !== null && (!model.modelEpochValid || model.modelEpoch !== state.epoch))) {
    clearWorkspaceModelAssociation()
  }
}

/** Deleting the workspace file does not discard the live model. */
export function markWorkspaceModelDeleted(path: string): void {
  if (useModelAssociation.getState().path === path) useModelAssociation.setState({ status: 'missing' })
}
