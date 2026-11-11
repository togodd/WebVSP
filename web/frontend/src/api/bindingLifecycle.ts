// A standalone lifecycle model, not connected to writeback. One instance represents
// one caller-chosen lane; it neither identifies files nor makes aliases safe.
// Calls reporting completion/failure must reflect actual settlement (including any
// required cleanup), not a UI timeout or a caller abandoning its wait.
// This unintegrated prototype retains all snapshots, including failures, without
// bound. Production use requires explicit capacity and retention management;
// failed snapshots must not be silently discarded as an automatic cleanup.
// Copying a SharedArrayBuffer-backed view does not guarantee a coherent snapshot
// against concurrent mutations; callers must provide a synchronization boundary.
export type SnapshotStatus = 'pending' | 'discarded' | 'started' | 'closing' | 'completed' | 'failed'
export type Binding = Readonly<{ id: bigint; path: string }>
export type Snapshot = Readonly<{ id: bigint; bindingId: bigint; sequence: bigint }>

type RecordEntry = { token: Snapshot; bytes: Uint8Array; status: SnapshotStatus; error?: string }

export class BindingLifecycle {
  private nextBinding = 0n
  private nextSnapshot = 0n
  private nextSequence = 0n
  private readonly bindings = new Map<string, Binding>()
  private readonly snapshots = new Map<Snapshot, RecordEntry>()
  private active?: RecordEntry

  bind(path: string): Binding {
    const old = this.bindings.get(path)
    if (old) this.invalidate(old)
    const binding = Object.freeze({ id: ++this.nextBinding, path })
    this.bindings.set(path, binding)
    return binding
  }

  invalidate(binding: Binding): boolean {
    if (this.bindings.get(binding.path) !== binding) return false
    this.bindings.delete(binding.path)
    for (const entry of this.snapshots.values()) {
      if (entry.token.bindingId === binding.id && entry.status === 'pending') entry.status = 'discarded'
    }
    return true
  }

  capture(binding: Binding, bytes: Uint8Array): Snapshot {
    if (this.bindings.get(binding.path) !== binding) throw new Error('binding is not current')
    const copy = Uint8Array.from(bytes)
    // A custom iterator may synchronously reenter and invalidate this binding or
    // capture another snapshot. Assign ordering only after copying and rechecking.
    if (this.bindings.get(binding.path) !== binding) throw new Error('binding is not current')
    const token = Object.freeze({ id: ++this.nextSnapshot, bindingId: binding.id, sequence: ++this.nextSequence })
    this.snapshots.set(token, { token, bytes: copy, status: 'pending' })
    return token
  }

  // The byte array returned is a copy, never the retained snapshot.
  bytes(snapshot: Snapshot): Uint8Array { return this.entry(snapshot).bytes.slice() }
  status(snapshot: Snapshot): SnapshotStatus { return this.entry(snapshot).status }
  failure(snapshot: Snapshot): string | undefined { return this.entry(snapshot).error }
  isBusy(): boolean { return this.active !== undefined }

  start(snapshot: Snapshot): boolean {
    const entry = this.entry(snapshot)
    if (entry.status !== 'pending' || this.active) return false
    // Preserve lane FIFO across bindings; discarded and settled entries do not block.
    for (const earlier of this.snapshots.values()) {
      if (earlier === entry) break
      if (earlier.status === 'pending') return false
    }
    // Recheck the generation in the same synchronous step as acquiring the lane.
    if (![...this.bindings.values()].some(binding => binding.id === snapshot.bindingId)) return false
    entry.status = 'started'
    this.active = entry
    return true
  }

  closeStarted(snapshot: Snapshot): void {
    const entry = this.requireActive(snapshot, 'started')
    entry.status = 'closing'
  }

  complete(snapshot: Snapshot): void {
    const entry = this.requireActive(snapshot, 'closing')
    entry.status = 'completed'
    this.active = undefined
  }

  fail(snapshot: Snapshot, error: string): void {
    const entry = this.entry(snapshot)
    if (this.active !== entry || (entry.status !== 'started' && entry.status !== 'closing')) {
      throw new Error('snapshot is not active')
    }
    entry.status = 'failed'
    entry.error = error
    this.active = undefined
  }

  private entry(snapshot: Snapshot): RecordEntry {
    const entry = this.snapshots.get(snapshot)
    if (!entry) throw new Error('unknown snapshot')
    return entry
  }

  private requireActive(snapshot: Snapshot, status: SnapshotStatus): RecordEntry {
    const entry = this.entry(snapshot)
    if (this.active !== entry || entry.status !== status) throw new Error(`snapshot is not ${status}`)
    return entry
  }
}
