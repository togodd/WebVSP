/** Deliver to each listener independently, retaining Set's live iteration semantics. */
export function emitListeners<T>(listeners: Set<(event: T) => void>, event: T): void {
  listeners.forEach((listener) => {
    try {
      listener(event)
    } catch (error) {
      console.error('WebVSP event listener:', error)
    }
  })
}
