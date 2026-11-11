import type { CapabilityName } from './contracts'
import type { ModelingProtocolOperation, ModelingProtocolResult } from './protocol'

export type ProtocolCapabilityStatus = 'declared' | 'not_declared' | 'unknown'
export interface ProtocolCapability {
  name: CapabilityName
  status: ProtocolCapabilityStatus
  /** null means the requirements or declaration are unknown, not that none are missing. */
  missingOperations: ModelingProtocolOperation[] | null
}

// Each read capability covers every corresponding public facade method, including
// guarded calls and composite reads. Discovery is only used by unscoped getInfo.
// A null requirement denotes a capability for which v1 defines no sufficient set.
const requirements: ReadonlyArray<readonly [CapabilityName, readonly ModelingProtocolOperation[] | null]> = [
  ['model.read', ['modelDiscovery', 'model', 'bbox', 'guardedEpochV1']],
  ['geometry.read', ['model', 'guardedEpochV1']],
  ['geometry.create', null],
  ['geometry.move', null],
  ['parameter.read', ['geomXSecs', 'fuselageLength', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm', 'guardedEpochV1']],
  ['parameter.write', null],
  ['wing.read', ['model', 'wingXSecShapes', 'guardedEpochV1']],
  ['wing.edit', null],
  ['fuselage.read', ['model', 'fuselageLength', 'fuselageXSecShapes', 'guardedEpochV1']],
  ['fuselage.edit', null],
  ['assembly.attach', null],
]

/**
 * Evaluate a parsed protocol declaration, not actual engine support, readiness,
 * safety or authorization. not_declared only means required names are absent
 * from this declaration. Writes and other capabilities without a sufficient v1
 * vocabulary remain unknown even when all known operations are declared.
 * Invalid input has no usable declaration; its missing operations are unknown.
 */
export function protocolCapabilities(protocol: ModelingProtocolResult): ProtocolCapability[] {
  const declared = protocol.status === 'valid' ? new Set(protocol.operations) : null
  return requirements.map(([name, required]) => {
    if (!declared || !required) return { name, status: 'unknown', missingOperations: null }
    const missingOperations = required.filter(op => !declared.has(op))
    return { name, status: missingOperations.length ? 'not_declared' : 'declared', missingOperations }
  })
}
