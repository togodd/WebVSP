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
