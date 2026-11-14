import { MOUSE } from 'three'
import type { OrbitControls } from 'three-stdlib'

/** Configure the next mouse gesture without changing the event seen by selection or gizmos.
 * OrbitControls swaps ROTATE and PAN for Ctrl/Meta/Shift; compensate for that here.
 * The chosen action is latched by OrbitControls at pointerdown. */
export function configureOpenVspMouse(controls: OrbitControls, event: PointerEvent) {
  if (event.pointerType === 'touch') return
  const swapped = event.ctrlKey || event.metaKey || event.shiftKey
  const action = event.button === 0
    ? (event.altKey ? MOUSE.PAN : event.ctrlKey || event.metaKey ? MOUSE.DOLLY : MOUSE.ROTATE)
    : event.button === 1 ? MOUSE.DOLLY : event.button === 2 ? MOUSE.PAN : null
  if (action === null) return
  const mapped = swapped && action !== MOUSE.DOLLY
    ? (action === MOUSE.PAN ? MOUSE.ROTATE : MOUSE.PAN)
    : action
  if (event.button === 0) controls.mouseButtons.LEFT = mapped
  else if (event.button === 1) controls.mouseButtons.MIDDLE = mapped
  else controls.mouseButtons.RIGHT = mapped
}
