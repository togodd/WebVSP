/** A staged import is only returned after every input has been validated and copied. */
export interface ImportSource {
  readonly name: string
}

export interface StagedImport {
  readonly name: string
  readonly data: Uint8Array
}

/** Return the first target whose current path binding has unfinished write-back. */
export function busyImportPath(paths: readonly string[], linked: ReadonlyMap<string, { pending: boolean; writing: boolean }>): string | undefined {
  return paths.find(path => {
    const binding = linked.get(path)
    return binding?.pending || binding?.writing
  })
}

/**
 * Check only current exact-path bindings, without changing the watcher's baseline.
 * Emscripten uses errno 44 for ENOENT. A missing file is acceptable only if the
 * binding was created missing (size -1); all other stat errors are unsafe.
 * Metadata cannot detect aliases, ABA, or writes racing this check and commit.
 */
export function unsafeLinkedPath(
  paths: readonly string[],
  linked: ReadonlyMap<string, { pending: boolean; writing: boolean; mtime: number; size: number }>,
  fs: { stat(path: string): { mtime: Date; size: number } },
): string | undefined {
  return paths.find(path => {
    const binding = linked.get(path)
    if (!binding) return false
    if (binding.pending || binding.writing) return true
    try {
      const st = fs.stat(path)
      const mtime = st.mtime.getTime()
      return !Number.isFinite(mtime) || !Number.isSafeInteger(st.size) || st.size < 0 ||
        mtime !== binding.mtime || st.size !== binding.size
    } catch (error) {
      return !(binding.size === -1 && (error as { errno?: number } | null)?.errno === 44)
    }
  })
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

export interface ImportMetadataSource extends ImportSource {
  readonly size: number
}

/** All limits are caller-selected; names are measured in UTF-16 code units. */
export interface ImportMetadataLimits {
  readonly maxCount: number
  readonly maxBytes: number
  readonly maxNameLength: number
  readonly maxTotalNameLength: number
}

/**
 * Opt-in preflight: snapshot and check every name and declared size before the
 * first data read. The existing stageImport still checks actual copied bytes.
 * Declared sizes can be wrong, getters/proxies can have arbitrary effects, and
 * neither limits nor preflight bound actual total memory or source allocations.
 * Callers must also synchronize mutable sources and choose appropriate limits.
 */
export async function stageImportWithMetadata<T extends ImportMetadataSource>(
  sources: readonly T[],
  getData: (source: T) => Uint8Array | Promise<Uint8Array>,
  limits: ImportMetadataLimits,
): Promise<StagedImport[]> {
  if (limits == null || typeof limits !== 'object') throw new TypeError('Invalid import metadata limits')
  const { maxCount, maxBytes, maxNameLength, maxTotalNameLength } = limits
  for (const limit of [maxCount, maxBytes, maxNameLength, maxTotalNameLength]) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid import metadata limit')
  }
  if (!Array.isArray(sources) || typeof getData !== 'function') throw new TypeError('Invalid import sources')
  const count = sources.length
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid import count')
  if (count === 0) throw new TypeError('Invalid import sources')
  if (count > maxCount) throw new RangeError('Import count limit exceeded')

  const inputs: { source: T; name: string }[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  let totalNameLength = 0
  for (let i = 0; i < count; i++) {
    const source = sources[i]
    if (source == null || typeof source !== 'object') throw new TypeError('Invalid import source')
    const rawName = source.name
    if (typeof rawName !== 'string') throw new TypeError('Invalid import name')
    const nameLength = rawName.length
    if (nameLength > maxNameLength || nameLength > maxTotalNameLength - totalNameLength) {
      throw new RangeError('Import name length limit exceeded')
    }
    const name = normalizeImportName(rawName)
    if (seen.has(name)) throw new TypeError('Duplicate import basename')
    const size = source.size
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid import metadata')
    if (size > maxBytes - totalBytes) throw new RangeError('Import byte limit exceeded')
    totalNameLength += nameLength
    totalBytes += size
    seen.add(name)
    inputs.push({ source, name })
  }
  return stageImport(inputs, input => getData(input.source), maxBytes)
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const typedArraySet = Uint8Array.prototype.set
