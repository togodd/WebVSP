/** Identity evidence only; this does not serialize writes or reserve a target. */
export type FileHandleIdentity = 'same' | 'different' | 'unknown'

type ComparableHandle = { isSameEntry(other: ComparableHandle): Promise<boolean> }

/**
 * Conservative symmetric comparison. Missing methods, errors, or inconsistent
 * answers are unknown. A pending comparison has no timeout or cancellation.
 * Callers must independently control resource limits and registration races.
 */
export async function compareFileHandles(a: ComparableHandle, b: ComparableHandle): Promise<FileHandleIdentity> {
  if (a === b && a != null) return 'same'
  try {
    if (a == null || b == null) return 'unknown'
    const left = a.isSameEntry, right = b.isSameEntry
    if (typeof left !== 'function' || typeof right !== 'function') return 'unknown'
    const [ab, ba] = await Promise.all([
      Promise.resolve().then(() => Reflect.apply(left, a, [b])),
      Promise.resolve().then(() => Reflect.apply(right, b, [a])),
    ])
    return ab === true && ba === true ? 'same' : ab === false && ba === false ? 'different' : 'unknown'
  } catch {
    return 'unknown'
  }
}
