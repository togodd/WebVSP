import { create } from 'zustand'

export type FileNotice = { id: number; kind: 'busy' | 'error' | 'quarantine'; operation: 'open' | 'save'; name?: string }

type State = { notice: FileNotice | null }
export const useFileNotice = create<State>(() => ({ notice: null }))
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined

/** Best-effort UI only; it must never interfere with an engine dialog answer. */
export function notifyFileError(notice: Omit<FileNotice, 'id'>) {
  const id = ++sequence
  if (timer !== undefined) clearTimeout(timer)
  useFileNotice.setState({ notice: { ...notice, id } })
  timer = setTimeout(() => {
    if (useFileNotice.getState().notice?.id === id) useFileNotice.setState({ notice: null })
    timer = undefined
  }, 10000)
}

export function safelyNotifyFileError(notice: Omit<FileNotice, 'id'>) {
  try { notifyFileError(notice) } catch { /* notification is strictly best effort */ }
}
