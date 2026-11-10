type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** Register before submitting, and forget the request if submission throws synchronously. */
export function submitPending(pending: Map<number, Pending>, id: number, submit: () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      submit()
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

/** Discard an orphaned binary result, which otherwise remains in the engine's result map. */
export function takePending(pending: Map<number, Pending>, id: number, binary: boolean, discardBinary: (id: number) => unknown): Pending | undefined {
  const entry = pending.get(id)
  if (entry) pending.delete(id)
  else if (binary) discardBinary(id)
  return entry
}
