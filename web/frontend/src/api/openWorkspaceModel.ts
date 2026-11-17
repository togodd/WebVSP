import { openEngineModel } from './wasmEngine'
import { useStore } from '../store'
import { associateWorkspaceModel, clearWorkspaceModelAssociation } from '../workspace/modelAssociation'

/**
 * Replace the current model with a VSP3 in /work. The caller must obtain any
 * desired confirmation first: OpenVSP clears the model before reading and a
 * failed read is not rolled back. Errors are propagated to the caller.
 */
export async function openWorkspaceModel(path: string): Promise<void> {
  if (!/^\/work\/(?!.*(?:^|\/)\.\.?\/)[^\\\0]+\.vsp3$/i.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Expected a VSP3 file path inside /work')
  }

  let openError: unknown
  try {
    await openEngineModel(path)
  } catch (error) {
    openError = error
  }

  // Invalidate the old tree even if fetching the replacement tree fails.
  const oldState = useStore.getState()
  const invalidated = { ...oldState.meshRev }
  for (const geom of oldState.tree?.geoms ?? []) invalidated[geom.id] = (invalidated[geom.id] ?? 0) + 1
  useStore.setState({ meshRev: invalidated })

  let refreshError: unknown
  try {
    await useStore.getState().loadTree()
    // A replacement may reuse IDs, so invalidate even meshes in the new tree.
    const state = useStore.getState()
    const meshRev = { ...state.meshRev }
    for (const geom of state.tree?.geoms ?? []) meshRev[geom.id] = (meshRev[geom.id] ?? 0) + 1
    useStore.setState({ meshRev })
  } catch (error) {
    refreshError = error
  } finally {
    useStore.getState().refitAll()
  }

  // A failed read may have replaced the old model; do not retain a stale association.
  if (openError || refreshError) clearWorkspaceModelAssociation()
  else {
    const tree = useStore.getState().tree
    if (!tree) {
      clearWorkspaceModelAssociation()
      throw new Error('Model was opened, but no model snapshot is available')
    }
    associateWorkspaceModel(path, tree)
  }

  if (openError && refreshError) throw new AggregateError([openError, refreshError], 'Model open failed and the model view could not be refreshed; the previous model may have been replaced')
  if (openError) throw openError
  if (refreshError) throw new Error('Model was opened, but the model view could not be refreshed', { cause: refreshError })
}
