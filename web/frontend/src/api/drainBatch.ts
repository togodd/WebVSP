// A proc handler can throw synchronously; isolate it without losing the rest of the batch.
export function drainBatch<P, O, M>(
  batch: { proc: P[]; out: O[]; mirror: M[] },
  handleProc: (request: P) => void,
  handleOut: (message: O) => void,
  handleMirror: (messages: M[]) => void,
): void {
  for (const request of batch.proc) {
    try {
      handleProc(request)
    } catch (err) {
      console.error('WebVSP process request:', err)
    }
  }
  for (const message of batch.out) handleOut(message)
  if (batch.mirror.length) handleMirror(batch.mirror)
}
