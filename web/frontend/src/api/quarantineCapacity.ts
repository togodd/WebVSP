/** Exact-string, page-instance-local isolation capacity; not a bound on overall memory. */
export interface QuarantineReservation {
  /** Invoke once. A throw or rejected result permanently isolates the entire batch. */
  commit<T>(operation: () => T | PromiseLike<T>): Promise<{ value: Awaited<T> }>
  /** Release an uncommitted reservation. Returns false once committing or settled. */
  cancel(): boolean
}

export type ReservationResult =
  | { readonly ok: true; readonly reservation: QuarantineReservation }
  | { readonly ok: false; readonly reason: 'invalid' | 'duplicate' | 'conflict' | 'capacity' }

/**
 * Counts exact string keys and their UTF-16 code units, including active reservations.
 * No normalization or alias detection is performed. A failed commit retains every key
 * forever in this instance; only discarding the entire instance resets isolation.
 * Reservation is synchronous and all-or-nothing. Reentrant input access is allowed:
 * conflicts/capacity are checked again after the complete input snapshot is read.
 * This limits retained key count/length, not inputs, callbacks, temporary allocations,
 * JS runtime overhead, or overall memory. Catastrophic runtime failures are excluded.
 */
export class QuarantineCapacity {
  private readonly keys = new Map<string, 'reserved' | 'quarantined'>()
  private units = 0

  readonly maxEntries: number
  readonly maxUnits: number

  constructor(maxEntries: number, maxUnits: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 ||
        !Number.isSafeInteger(maxUnits) || maxUnits < 0) {
      throw new RangeError('Invalid quarantine capacity')
    }
    this.maxEntries = maxEntries
    this.maxUnits = maxUnits
  }

  /** Both reserved and permanently quarantined keys are unavailable. */
  has(key: string): boolean { return this.keys.has(key) }
  get entryCount(): number { return this.keys.size }
  get codeUnits(): number { return this.units }

  reserve(input: readonly string[]): ReservationResult {
    // Input access can throw or reenter; no state changes until snapshot is complete.
    const batch: string[] = []
    const unique = new Set<string>()
    let size = 0
    try {
      if (!Array.isArray(input)) return { ok: false, reason: 'invalid' }
      const length = input.length
      if (!Number.isSafeInteger(length) || length <= 0) return { ok: false, reason: 'invalid' }
      // Avoid even reading a batch that could never fit by entry count.
      if (length > this.maxEntries) return { ok: false, reason: 'capacity' }
      for (let i = 0; i < length; i++) {
        const key: unknown = input[i]
        if (typeof key !== 'string' || key.length === 0) return { ok: false, reason: 'invalid' }
        if (unique.has(key)) return { ok: false, reason: 'duplicate' }
        unique.add(key)
        if (key.length > this.maxUnits - size) return { ok: false, reason: 'capacity' }
        size += key.length
        batch.push(key)
      }
    } catch {
      return { ok: false, reason: 'invalid' }
    }
    if (batch.some(key => this.keys.has(key))) return { ok: false, reason: 'conflict' }
    if (batch.length > this.maxEntries - this.keys.size || size > this.maxUnits - this.units) {
      return { ok: false, reason: 'capacity' }
    }
    for (const key of batch) this.keys.set(key, 'reserved')
    this.units += size
    let state: 'reserved' | 'committing' | 'settled' = 'reserved'
    const release = () => {
      for (const key of batch) this.keys.delete(key)
      this.units -= size
    }
    const reservation: QuarantineReservation = {
      cancel: () => {
        if (state !== 'reserved') return false
        state = 'settled'
        release()
        return true
      },
      commit: async <T>(operation: () => T | PromiseLike<T>): Promise<{ value: Awaited<T> }> => {
        if (state !== 'reserved') throw new Error('Reservation already used')
        // Set before calling arbitrary code, including thenable assimilation.
        state = 'committing'
        try {
          if (typeof operation !== 'function') throw new TypeError('Invalid commit operation')
          const result = await operation()
          state = 'settled'
          release()
          // Never return the callback result directly: async return would assimilate
          // a mutable then getter a second time after releasing the reservation.
          return { value: result }
        } catch (error) {
          state = 'settled'
          for (const key of batch) this.keys.set(key, 'quarantined')
          throw error
        }
      },
    }
    return { ok: true, reservation }
  }
}
