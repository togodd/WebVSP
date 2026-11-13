/** A request awaiting a response from the engine. */
export type BridgePending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/**
 * Settle one `out` result. Binary extraction failures belong to this result only:
 * reject its pending request, or ignore the failure if the result is orphaned.
 * The caller can therefore continue delivering the rest of the drained batch.
 * Non-binary engine errors are constructed by the caller to preserve its error API.
 */
export function settleBridgeResult(
  pending: Map<number, BridgePending>,
  result: Record<string, unknown>,
  takeBinary: (id: number) => Uint8Array | null,
  makeError: (result: Record<string, unknown>) => unknown,
): void {
  const id = result.id as number
  const entry = pending.get(id)
  if (!entry) {
    // The engine retains binary payloads until taken, even for orphaned responses.
    if (result.bin) {
      try { takeBinary(id) } catch { /* No pending request to reject. */ }
    }
    return
  }
  pending.delete(id)
  // Only the engine's boolean discriminator and string error establish a
  // trustworthy result. In particular, never promote malformed metadata to a
  // WasmEngineError: a dispatched write may already have taken effect.
  if (typeof result.ok !== 'boolean' || (result.ok === false && typeof result.error !== 'string')) {
    // A malformed result may still have caused the engine to retain a payload.
    if (result.bin) {
      try { takeBinary(id) } catch { /* Preserve the protocol error. */ }
    }
    entry.reject(new Error('Invalid engine result response'))
  } else if (result.ok === false) {
    let error: unknown
    try {
      error = makeError(result)
    } catch {
      error = new Error('Invalid engine error response')
    }
    entry.reject(error)
  } else if (result.bin) {
    try {
      const bytes = takeBinary(id)
      entry.resolve(bytes ? bytes.buffer : new ArrayBuffer(0))
    } catch (error) {
      entry.reject(error)
    }
  } else {
    entry.resolve(result.value)
  }
}
