/** Version 1 engine-manifest vocabulary. Recognition is not evidence of readiness or permission. */
export const MODELING_PROTOCOL_OPERATIONS = Object.freeze([
  'modelDiscovery', 'model', 'bbox', 'origin', 'geomXSecs',
  'fuselageXSecShapes', 'wingXSecShapes', 'geomParmIDs', 'xsecParmIDs',
  'geomParm', 'xsecParm', 'fuselageLength', 'guardedEpochV1',
] as const)

export type ModelingProtocolOperation = (typeof MODELING_PROTOCOL_OPERATIONS)[number]
export type ModelingProtocolResult =
  | { status: 'valid'; operations: ModelingProtocolOperation[] }
  | { status: 'invalid'; operations: [] }

const known = new Set<string>(MODELING_PROTOCOL_OPERATIONS)
// Bound work and memory even for input that did not come from JSON.parse.
const MAX_OPERATIONS = 1024
const MAX_OPERATION_LENGTH = 256

/** Read only own data properties: never execute an ordinary getter. */
function ownValue(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !('value' in descriptor)) throw new Error('Invalid property')
  return descriptor.value
}

/**
 * Parse an untrusted v1 manifest. Unknown operations and extra fields are ignored;
 * duplicates, including duplicate unknown operations, invalidate the entire manifest.
 * Missing, malformed or exceptional input returns no operations. Proxy traps can run
 * during reflection; exceptions are caught, but JavaScript cannot prevent trap effects
 * or prove a proxy is truthful. Parse JSON first when that distinction matters.
 * A valid result only describes a declaration, never engine readiness or authorization.
 */
export function parseModelingProtocol(input: unknown): ModelingProtocolResult {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid manifest')
    if (ownValue(input, 'protocol') !== 'webvsp-modeling' || ownValue(input, 'version') !== 1) throw new Error('Unsupported protocol')
    const operations = ownValue(input, 'operations')
    if (!Array.isArray(operations)) throw new Error('Invalid operations')
    const length = ownValue(operations, 'length')
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_OPERATIONS) throw new Error('Invalid length')
    const seen = new Set<string>()
    const recognized: ModelingProtocolOperation[] = []
    for (let i = 0; i < length; i++) {
      const op = ownValue(operations, String(i))
      if (typeof op !== 'string' || op.length === 0 || op.length > MAX_OPERATION_LENGTH || seen.has(op)) throw new Error('Invalid operation')
      seen.add(op)
      if (known.has(op)) recognized.push(op as ModelingProtocolOperation)
    }
    return { status: 'valid', operations: recognized }
  } catch {
    return { status: 'invalid', operations: [] }
  }
}
