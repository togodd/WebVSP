/** Identity evidence only; this does not serialize writes or reserve a target. */
export type FileHandleIdentity = 'same' | 'different' | 'unknown'

type ComparableHandle = { isSameEntry(other: ComparableHandle): Promise<boolean> }

/**
 * For honest, stable handles, compare in both directions; inconsistent results,
 * missing methods or errors are unknown. Identical references bypass comparison,
 * even if invalid. Answers are evidence, not proof of current existence, permission,
 * path identity, or write safety. Side-effectful handles can give order-dependent
 * answers. Rejection returns unknown without canceling the other comparison; if one
 * stays pending and neither rejects, this stays pending. There is no timeout.
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
