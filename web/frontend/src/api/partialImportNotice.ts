import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

interface PartialImportState { notices: number[] }

// Wrap subscriptions before exposing the store, including to React's useStore.
const store = createStore<PartialImportState>(() => ({ notices: [] }))
const subscribe = store.subscribe
store.subscribe = listener => subscribe((state, previousState) => {
  try { listener(state, previousState) } catch { /* one observer must not block the others */ }
})
export const usePartialImportNotice = Object.assign(
  <T>(selector: (state: PartialImportState) => T): T => useStore(store, selector),
  store,
)
let sequence = 0

/** One persistent in-page warning for identical messages; not a disk log or recovery mechanism. */
export function notifyPartialImport() {
  const id = ++sequence
  store.setState({ notices: [id] })
}

/** A stale dismissal cannot remove a warning that arrived since it was rendered. */
export function dismissPartialImport(id: number) {
  store.setState(state => state.notices.includes(id)
    ? { notices: state.notices.filter(item => item !== id) }
    : state)
}

export function safelyNotifyPartialImport() {
  try { notifyPartialImport() } catch { /* dialog completion must not depend on observers */ }
}
