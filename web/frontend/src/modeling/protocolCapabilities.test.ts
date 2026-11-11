import { describe, expect, it } from 'vitest'
import { MODELING_PROTOCOL_OPERATIONS, parseModelingProtocol } from './protocol'
import { protocolCapabilities } from './protocolCapabilities'
import type { CapabilityName } from './contracts'
import type { ModelingProtocolOperation } from './protocol'

const parse = (operations: string[]) => parseModelingProtocol({ protocol: 'webvsp-modeling', version: 1, operations })
const expected: Partial<Record<CapabilityName, ModelingProtocolOperation[]>> = {
  'model.read': ['modelDiscovery', 'model', 'bbox', 'guardedEpochV1'],
  'geometry.read': ['model', 'guardedEpochV1'],
  'parameter.read': ['geomXSecs', 'fuselageLength', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm', 'guardedEpochV1'],
  'wing.read': ['model', 'wingXSecShapes', 'guardedEpochV1'],
  'fuselage.read': ['model', 'fuselageLength', 'fuselageXSecShapes', 'guardedEpochV1'],
}
const names: CapabilityName[] = ['model.read', 'geometry.read', 'geometry.create', 'geometry.move', 'parameter.read', 'parameter.write', 'wing.read', 'wing.edit', 'fuselage.read', 'fuselage.edit', 'assembly.attach']

describe('protocol capability declarations', () => {
  it('reports every capability and all missing operations for an empty valid declaration', () => {
    const results = protocolCapabilities(parse([]))
    expect(results.map(result => result.name)).toEqual(names)
    for (const result of results) {
      const requirements = expected[result.name]
      expect(result).toEqual(requirements
        ? { name: result.name, status: 'not_declared', missingOperations: requirements }
        : { name: result.name, status: 'unknown', missingOperations: null })
    }
  })

  it('declares only fully covered reads, never writes, even with all operations', () => {
    const results = protocolCapabilities(parse([...MODELING_PROTOCOL_OPERATIONS, 'futureWrite']))
    for (const result of results) expect(result).toEqual(expected[result.name]
      ? { name: result.name, status: 'declared', missingOperations: [] }
      : { name: result.name, status: 'unknown', missingOperations: null })
  })

  it('identifies every individually omitted requirement, without unrelated false dependencies', () => {
    for (const omitted of MODELING_PROTOCOL_OPERATIONS) {
      const results = protocolCapabilities(parse(MODELING_PROTOCOL_OPERATIONS.filter(op => op !== omitted)))
      for (const result of results) {
        const requirements = expected[result.name]
        if (!requirements) continue
        const missing = requirements.filter(op => op === omitted)
        expect(result).toEqual({ name: result.name, status: missing.length ? 'not_declared' : 'declared', missingOperations: missing })
      }
    }
  })

  it('treats invalid declarations as unknown, not empty declarations', () => {
    expect(protocolCapabilities(parse(['model', 'model']))).toEqual(names.map(name => ({ name, status: 'unknown', missingOperations: null })))
  })

  it('does not mutate its input and returns independent arrays', () => {
    const declaration = parse([])
    const first = protocolCapabilities(declaration)
    first[0].missingOperations!.push('origin')
    first.pop()
    expect(declaration).toEqual({ status: 'valid', operations: [] })
    expect(protocolCapabilities(declaration)[0].missingOperations).toEqual(expected['model.read'])
  })
})
