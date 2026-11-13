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
          // Listener results are void: observe only the first settlement, never assimilate
          // its success value. A then implementation that itself loops forever cannot be guarded.
          queueMicrotask(() => {
            let settled = false
            const resolve = () => { settled = true }
            const reject = (error: unknown) => {
              if (settled) return
              settled = true
              report(error, true)
            }
            try { Reflect.apply(then, result, [resolve, reject]) } catch (error) { reject(error) }
          })
        }
      }
    } catch (error) {
      failed = true
      report(error, false)
    }
  })
  return !failed
}
