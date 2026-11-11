/** A staged import is only returned after every input has been validated and copied. */
export interface ImportSource {
  readonly name: string
}

export interface StagedImport {
  readonly name: string
  readonly data: Uint8Array
}

/**
 * Names are exact, case-sensitive strings: no case folding or Unicode normalization.
 * Only a single path component is accepted; path syntax is never resolved.
 * This is not a complete cross-platform filename portability check.
 */
export function normalizeImportName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..' ||
      /[\x00-\x1f\x7f/\\:]/.test(name)) {
    throw new TypeError('Invalid import basename')
  }
  return name
}

/**
 * Validate the complete name list before fetching any data, then copy each result
 * immediately. The byte limit applies to the sum of visible Uint8Array bytes.
 * This function performs no writes; consumers must commit only after it resolves.
 * Empty files are allowed; an empty import is not. The byte limit does not bound
 * source allocation, per-file metadata, or temporary memory; callers must limit
 * input count and synchronize concurrent mutations of shared-memory sources.
 */
export async function stageImport<T extends ImportSource>(
  sources: readonly T[],
  getData: (source: T) => Uint8Array | Promise<Uint8Array>,
  maxBytes: number,
): Promise<StagedImport[]> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid import byte limit')
  if (!Array.isArray(sources) || sources.length === 0 || typeof getData !== 'function') {
    throw new TypeError('Invalid import sources')
  }

  const seen = new Set<string>()
  const inputs: { source: T; name: string }[] = []
  for (const source of sources) {
    if (source == null || typeof source !== 'object') throw new TypeError('Invalid import source')
    const name = normalizeImportName(source.name)
    if (seen.has(name)) throw new TypeError('Duplicate import basename')
    seen.add(name)
    inputs.push({ source, name })
  }

  const staged: StagedImport[] = []
  let total = 0
  for (const { source, name } of inputs) {
    const data = await getData(source)
    if (!(data instanceof Uint8Array)) throw new TypeError('Invalid import data')
    // Intrinsic access rejects proxies/forged typed arrays and ignores own getters.
    const size = typedArrayByteLength.call(data)
    if (size > maxBytes - total) throw new RangeError('Import byte limit exceeded')
    const copy = new Uint8Array(size)
    typedArraySet.call(copy, data)
    total += size
    staged.push({ name, data: copy })
  }
  return staged
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const typedArraySet = Uint8Array.prototype.set
