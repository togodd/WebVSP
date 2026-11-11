import { create } from 'zustand'

interface PartialImportState { notices: number[] }
export const usePartialImportNotice = create<PartialImportState>(() => ({ notices: [] }))
let sequence = 0

/** Independent, persistent in-page queue; not a disk log and not a recovery mechanism. */
export function notifyPartialImport() {
  const id = ++sequence
  usePartialImportNotice.setState(state => ({ notices: [...state.notices, id] }))
}

export function dismissPartialImport(id: number) {
  usePartialImportNotice.setState(state => ({ notices: state.notices.filter(item => item !== id) }))
}

export function safelyNotifyPartialImport() {
  try { notifyPartialImport() } catch { /* dialog completion must not depend on observers */ }
}
