import type { TransformControls } from 'three-stdlib'

/** Own an already constructed control. Cleanup cancels, never synthesizes mouseUp. */
export function ownGizmo(controls: TransformControls, element: HTMLElement, cancel: () => void) {
  const unguard = guardGizmoMouse(controls, element)
  return () => {
    const state = controls as unknown as { dragging: boolean }
    if (state.dragging) cancel()
    // Dispatch dragging-changed so the orbit controls are re-enabled before teardown.
    state.dragging = false
    unguard()
    controls.detach()
    controls.dispose()
    element.style.touchAction = ''
  }
}

/** Reserve modified left drags for camera navigation without changing enabled state. */
export function guardGizmoMouse(controls: TransformControls, element: HTMLElement) {
  // Version-coupled to three-stdlib: connect() installs this bound listener and dispose()
  // removes it. Verify this contract when upgrading; the declarations mark it private.
  const original = (controls as unknown as { onPointerDown: (event: PointerEvent) => void }).onPointerDown
  const guarded = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.button === 0 && (event.altKey || event.ctrlKey || event.metaKey)) return
    original(event)
  }
  element.removeEventListener('pointerdown', original)
  element.addEventListener('pointerdown', guarded)
  // The control is either being disposed or immediately re-guarded by the effect. Never
  // re-add its original listener: drei may already have disposed it before this cleanup.
  return () => element.removeEventListener('pointerdown', guarded)
}
