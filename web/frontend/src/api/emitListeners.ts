/** Deliver to each listener independently, retaining Set's live iteration semantics. */
export function emitListeners<T>(listeners: Set<(event: T) => void>, event: T, privateFailure = false): boolean {
  let failed = false
  listeners.forEach((listener) => {
    try {
      listener(event)
    } catch (error) {
      failed = true
      if (!privateFailure) {
        try { console.error('WebVSP event listener:', error) } catch { /* best effort */ }
      }
    }
  })
  return !failed
}
