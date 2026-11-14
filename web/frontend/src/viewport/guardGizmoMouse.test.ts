import { describe, expect, it } from 'vitest'
import { afterEach } from 'vitest'
import { PerspectiveCamera } from 'three'
import { TransformControls } from 'three-stdlib'
import { guardGizmoMouse, ownGizmo } from './guardGizmoMouse'

function event(props: Record<string, unknown> = {}) {
  return Object.assign(new Event('pointerdown'), { pointerType: 'mouse', button: 0, altKey: false, ctrlKey: false, metaKey: false }, props)
}
afterEach(() => { delete (globalThis as { document?: unknown }).document })

describe('gizmo mouse guard', () => {
  it('owns replacement instances without leaking listeners', () => {
    const doc = new EventTarget()
    ;(globalThis as { document?: unknown }).document = doc
    const el = Object.assign(new EventTarget(), { style: {}, ownerDocument: doc }) as unknown as HTMLElement
    const first = new TransformControls(new PerspectiveCamera(), el)
    const hits = [0, 0]
    const setup = (c: TransformControls, index: number) => {
      const runtime = c as unknown as { pointerHover: () => void; getPointer: () => object }
      runtime.getPointer = () => ({})
      runtime.pointerHover = () => { hits[index]++ }
    }
    setup(first, 0)
    const cleanupFirst = ownGizmo(first, el, () => {})
    el.dispatchEvent(event({ altKey: true }))
    expect(hits).toEqual([0, 0])
    el.dispatchEvent(event())
    expect(hits).toEqual([1, 0])
    cleanupFirst()
    const second = new TransformControls(new PerspectiveCamera(), el)
    setup(second, 1)
    const cleanupSecond = ownGizmo(second, el, () => {})
    el.dispatchEvent(event({ ctrlKey: true }))
    expect(hits).toEqual([1, 0])
    el.dispatchEvent(event())
    expect(hits).toEqual([1, 1])
    cleanupSecond()
    el.dispatchEvent(event())
    expect(hits).toEqual([1, 1])
  })
  it('cancels an active drag without dispatching mouseUp on disposal', () => {
    const doc = new EventTarget()
    ;(globalThis as { document?: unknown }).document = doc
    const el = Object.assign(new EventTarget(), { style: { touchAction: 'none' }, ownerDocument: doc }) as unknown as HTMLElement
    const controls = new TransformControls(new PerspectiveCamera(), el)
    const state = controls as unknown as { dragging: boolean; axis: string | null }
    const emitter = controls as unknown as { addEventListener: (name: string, cb: () => void) => void }
    let commits = 0
    let cancelled = 0
    emitter.addEventListener('mouseUp', () => { commits++ })
    state.axis = 'X'
    state.dragging = true
    const cleanup = ownGizmo(controls, el, () => { cancelled++ })
    cleanup()
    expect(cancelled).toBe(1)
    expect(commits).toBe(0)
    expect(state.dragging).toBe(false)
    expect(el.style.touchAction).toBe('')
    doc.dispatchEvent(new Event('pointerup'))
    expect(commits).toBe(0)
  })
  it('allows a normal release to commit once before cleanup', () => {
    const doc = new EventTarget()
    ;(globalThis as { document?: unknown }).document = doc
    const el = Object.assign(new EventTarget(), { style: {}, ownerDocument: doc }) as unknown as HTMLElement
    const controls = new TransformControls(new PerspectiveCamera(), el)
    const runtime = controls as unknown as { dragging: boolean; axis: string | null; pointerUp: (p: { button: number }) => void; addEventListener: (name: string, cb: () => void) => void }
    let commits = 0
    let cancels = 0
    runtime.addEventListener('mouseUp', () => { commits++ })
    const cleanup = ownGizmo(controls, el, () => { cancels++ })
    runtime.axis = 'X'
    runtime.dragging = true
    runtime.pointerUp({ button: 0 })
    cleanup()
    expect(commits).toBe(1)
    expect(cancels).toBe(0)
  })
  it('does not emit dragging-changed when disposed while idle', () => {
    const doc = new EventTarget()
    ;(globalThis as { document?: unknown }).document = doc
    const el = Object.assign(new EventTarget(), { style: {}, ownerDocument: doc }) as unknown as HTMLElement
    const controls = new TransformControls(new PerspectiveCamera(), el)
    const emitter = controls as unknown as { addEventListener: (name: string, cb: () => void) => void }
    let changes = 0
    emitter.addEventListener('dragging-changed', () => { changes++ })
    ownGizmo(controls, el, () => { throw new Error('idle cancel') })()
    expect(changes).toBe(0)
  })
  it('guards the actual three-stdlib listener after controls are remounted', () => {
    const doc = new EventTarget()
    ;(globalThis as { document?: unknown }).document = doc
    const el = Object.assign(new EventTarget(), { style: {}, ownerDocument: doc }) as unknown as HTMLElement
    const mount = () => {
      const controls = new TransformControls(new PerspectiveCamera(), el)
      let calls = 0
      // Its actual registered listener calls this method on a normal press.
      const runtime = controls as unknown as { pointerHover: () => void; getPointer: () => object }
      runtime.getPointer = () => ({})
      runtime.pointerHover = () => { calls++ }
      const cleanup = guardGizmoMouse(controls, el)
      return { controls, cleanup, calls: () => calls }
    }
    const first = mount()
    el.dispatchEvent(event({ altKey: true }))
    expect(first.calls()).toBe(0)
    // drei may dispose before the parent effect cleanup. Neither order may leak a listener.
    first.controls.dispose()
    first.cleanup()
    el.dispatchEvent(event())
    expect(first.calls()).toBe(0)
    const second = mount()
    el.dispatchEvent(event({ ctrlKey: true }))
    expect(second.calls()).toBe(0)
    el.dispatchEvent(event())
    expect(second.calls()).toBe(1)
    second.cleanup()
    second.controls.dispose()
  })
  it('reserves modified left presses and preserves normal input and enabled state', () => {
    const el = new EventTarget()
    let started = 0
    const controls = { enabled: true, onPointerDown: () => { started++ } }
    el.addEventListener('pointerdown', controls.onPointerDown as EventListener)
    const cleanup = guardGizmoMouse(controls as unknown as TransformControls, el as unknown as HTMLElement)
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) el.dispatchEvent(event({ [modifier]: true }))
    expect(started).toBe(0)
    expect(controls.enabled).toBe(true)
    el.dispatchEvent(new Event('pointercancel'))
    el.dispatchEvent(event())
    el.dispatchEvent(event({ pointerType: 'touch', altKey: true }))
    expect(started).toBe(2)
    controls.enabled = false
    el.dispatchEvent(event({ altKey: true }))
    expect(controls.enabled).toBe(false)
    cleanup()
    el.dispatchEvent(event({ altKey: true }))
    expect(started).toBe(2)
  })
})
