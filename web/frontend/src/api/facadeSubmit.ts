type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
type Observer = { outcome?: Outcome; listeners: Set<(outcome: Outcome) => void> }

// One reaction per shared startup promise; closed handles remove their subscriptions even
// if startup never completes. Observe ready immediately, including while load is pending.
const observers = new WeakMap<Promise<unknown>, Observer>()
function observe<T>(promise: Promise<T>): Observer {
  let observer = observers.get(promise)
  if (!observer) {
    observer = { listeners: new Set() }
    observers.set(promise, observer)
    const entry = observer
    const settle = (outcome: Outcome) => {
      entry.outcome = outcome
      for (const listener of entry.listeners) listener(outcome)
      entry.listeners.clear()
    }
    promise.then((value) => settle({ ok: true, value }), (error) => settle({ ok: false, error }))
  }
  return observer
}

function waitUntilOpen<T>(observer: Observer, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { signal.removeEventListener('abort', closed); observer.listeners.delete(settled) }
    const closed = () => { cleanup(); reject(new DOMException('Modeling session is closed', 'AbortError')) }
    const settled = (outcome: Outcome) => {
      cleanup()
      if (outcome.ok) resolve(outcome.value as T)
      else reject(outcome.error)
    }
    if (signal.aborted) { closed(); return }
    if (observer.outcome) { settled(observer.outcome); return }
    signal.addEventListener('abort', closed, { once: true })
    observer.listeners.add(settled)
  })
}

/** Abort only before submission. Once submitted, the bridge must retain its pending entry. */
export async function facadeSubmit<T, M>(signal: AbortSignal, load: () => Promise<M>, ready: Promise<void>, submit: (module: M) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new DOMException('Modeling session is closed', 'AbortError')
  const readyObserver = observe(ready)
  const module = await waitUntilOpen<M>(observe(load()), signal)
  await waitUntilOpen<void>(readyObserver, signal)
  if (signal.aborted) throw new DOMException('Modeling session is closed', 'AbortError')
  return submit(module)
}
