/** Deliver synchronously, retaining live Set iteration; the return reports synchronous failures only. */
export function emitListeners<T>(
  listeners: Set<(event: T) => void>, event: T, privateFailure = false, onAsyncFailure?: () => void,
): boolean {
  let failed = false
  const report = (error: unknown, async: boolean) => {
    if (privateFailure) {
      if (async) {
        try { onAsyncFailure?.() } catch { /* best effort */ }
      }
    } else {
      try { console.error('WebVSP event listener:', error) } catch { /* best effort */ }
    }
  }
  listeners.forEach((listener) => {
    try {
      // A void-returning listener may still return a Promise or another thenable.
      const result: unknown = listener(event)
      if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
        const then = (result as { then?: unknown }).then
        if (typeof then === 'function') {
          // Capture the getter once, but let Promise assimilation enforce single settlement
          // and contain exceptions thrown by the thenable itself.
          void Promise.resolve({ then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
            Reflect.apply(then, result, [resolve, reject]) }).catch((error: unknown) => report(error, true))
        }
      }
    } catch (error) {
      failed = true
      report(error, false)
    }
  })
  return !failed
}
