// A standalone lifecycle model, not connected to writeback. One instance represents
// one caller-chosen lane; it neither identifies files nor makes aliases safe.
// Calls reporting completion/failure must reflect actual settlement (including any
// required cleanup), not a UI timeout or a caller abandoning its wait.
// This unintegrated prototype retains snapshots until explicitly released.
// All snapshots, including failures, consume quota until release; none are evicted.
// Quotas cover retained byte lengths and snapshot count, not JS object overhead,
// bindings, or temporary copies returned to the caller.
// Copying a SharedArrayBuffer-backed view does not guarantee a coherent snapshot
// against concurrent mutations; callers must provide a synchronization boundary.
export type SnapshotStatus = 'pending' | 'discarded' | 'started' | 'closing' | 'completed' | 'failed'
export type Binding = Readonly<{ id: bigint; path: string }>
export type Snapshot = Readonly<{ id: bigint; bindingId: bigint; sequence: bigint }>
export type LifecycleLimits = Readonly<{ maxSnapshots: number; maxBytes: number }>

type RecordEntry = { token: Snapshot; bytes: Uint8Array; status: SnapshotStatus; error?: string }

// Use typed-array intrinsics rather than overridable properties or iterators.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!
const copyTypedArray = Uint8Array.prototype.set

export class BindingLifecycle {
  private nextBinding = 0n
  private nextSnapshot = 0n
  private nextSequence = 0n
  private readonly bindings = new Map<string, Binding>()
  private readonly snapshots = new Map<Snapshot, RecordEntry>()
  private active?: RecordEntry
  private retainedBytes = 0
  private readonly maxSnapshots: number
  private readonly maxBytes: number

  constructor(limits: LifecycleLimits = { maxSnapshots: 1024, maxBytes: 64 * 1024 * 1024 }) {
    const { maxSnapshots, maxBytes } = limits
    if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('limits must be non-negative safe integers')
    }
    this.maxSnapshots = maxSnapshots
    this.maxBytes = maxBytes
  }

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
    // Intrinsic brand and length checks reject proxies and non-Uint8Array views,
    // without invoking user-defined accessors, iterators, or species constructors.
    if (typedArrayTag.call(bytes) !== 'Uint8Array') throw new TypeError('expected Uint8Array')
    const length: number = typedArrayLength.call(bytes)
    if (this.snapshots.size >= this.maxSnapshots || length > this.maxBytes - this.retainedBytes) {
      throw new Error('snapshot quota exceeded')
    }
    const copy = new Uint8Array(length)
    copyTypedArray.call(copy, bytes)
    const token = Object.freeze({ id: ++this.nextSnapshot, bindingId: binding.id, sequence: ++this.nextSequence })
    this.snapshots.set(token, { token, bytes: copy, status: 'pending' })
    this.retainedBytes += copy.length
    return token
  }

  // The byte array returned is a copy, never the retained snapshot.
  bytes(snapshot: Snapshot): Uint8Array { return this.entry(snapshot).bytes.slice() }
  status(snapshot: Snapshot): SnapshotStatus { return this.entry(snapshot).status }
  failure(snapshot: Snapshot): string | undefined { return this.entry(snapshot).error }
  isBusy(): boolean { return this.active !== undefined }

  // Pending and active snapshots cannot be released. All terminal states require
  // the caller's explicit release, including failures and invalidated snapshots.
  release(snapshot: Snapshot): void {
    const entry = this.entry(snapshot)
    if (entry.status !== 'completed' && entry.status !== 'discarded' && entry.status !== 'failed') {
      throw new Error('snapshot is not releasable')
    }
    this.snapshots.delete(snapshot)
    this.retainedBytes -= entry.bytes.length
  }

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
