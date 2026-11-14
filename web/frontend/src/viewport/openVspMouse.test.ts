import { describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import { OrbitControls } from 'three-stdlib'
import { configureOpenVspMouse } from './openVspMouse'

class Surface extends EventTarget {
  style = { touchAction: '' }
  ownerDocument = new EventTarget()
  clientHeight = 500
  clientWidth = 500
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 500 } }
  releasePointerCapture() {}
}
function pointer(type: string, props: Record<string, unknown> = {}) {
  return Object.assign(new Event(type), { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 250, clientY: 250, pageX: 250, pageY: 250, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, props) as unknown as PointerEvent
}
function drag(button: number, modifiers: Record<string, boolean> = {}, enabled = true) {
  const surface = new Surface()
  const camera = new PerspectiveCamera(35, 1, 0.1, 1000)
  camera.position.set(0, 0, 10)
  // Node's EventTarget does not implement DOM capture ordering; register capture first.
  let controls: OrbitControls
  surface.addEventListener('pointerdown', (e) => configureOpenVspMouse(controls, e as PointerEvent), true)
  controls = new OrbitControls(camera, surface as unknown as HTMLElement)
  controls.enabled = enabled
  const position = camera.position.clone()
  const target = controls.target.clone()
  surface.dispatchEvent(pointer('pointerdown', { button, ...modifiers }))
  surface.ownerDocument.dispatchEvent(pointer('pointermove', { button, clientX: 280, clientY: 280, ...modifiers }))
  surface.ownerDocument.dispatchEvent(pointer('pointerup', { button, ...modifiers }))
  const targetMoved = controls.target.distanceTo(target) > 1e-6
  const distanceChanged = Math.abs(camera.position.distanceTo(controls.target) - position.distanceTo(target)) > 1e-6
  const positionMoved = camera.position.distanceTo(position) > 1e-6
  controls.dispose()
  return targetMoved ? 'pan' : distanceChanged ? 'zoom' : positionMoved ? 'rotate' : 'none'
}

describe('OpenVSP mouse mapping with real OrbitControls', () => {
  it.each([
    [0, {}, 'rotate'], [0, { shiftKey: true }, 'rotate'],
    [0, { altKey: true }, 'pan'], [0, { altKey: true, shiftKey: true }, 'pan'],
    [0, { ctrlKey: true }, 'zoom'], [0, { metaKey: true }, 'zoom'],
    [0, { altKey: true, ctrlKey: true }, 'pan'], [0, { altKey: true, metaKey: true }, 'pan'], [1, {}, 'zoom'],
    [2, {}, 'pan'], [2, { ctrlKey: true }, 'pan'], [2, { metaKey: true, shiftKey: true }, 'pan'],
  ])('button %i, modifiers %j => %s', (button, modifiers, expected) => {
    expect(drag(button, modifiers)).toBe(expected)
  })
  it('respects disabled controls, as while TransformControls is dragging', () => {
    expect(drag(0, { altKey: true }, false)).toBe('none')
  })
  it('leaves touch mappings alone', () => {
    const surface = new Surface()
    const controls = new OrbitControls(new PerspectiveCamera(), surface as unknown as HTMLElement)
    const before = { ...controls.mouseButtons }
    configureOpenVspMouse(controls, pointer('pointerdown', { pointerType: 'touch', altKey: true }))
    expect(controls.mouseButtons).toEqual(before)
    controls.dispose()
  })
})
