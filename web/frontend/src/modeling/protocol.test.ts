import { describe, expect, it, vi } from 'vitest'
import { MODELING_PROTOCOL_OPERATIONS, parseModelingProtocol } from './protocol'

const manifest = (operations: unknown = []) => ({ protocol: 'webvsp-modeling', version: 1, operations })
const invalid = { status: 'invalid', operations: [] }

describe('untrusted modeling protocol manifest', () => {
  it('recognizes the agreed engine vocabulary without claiming readiness', () => {
    expect(MODELING_PROTOCOL_OPERATIONS).toEqual(['modelDiscovery', 'model', 'geomTypes', 'bbox', 'origin', 'geomXSecs', 'fuselageXSecShapes', 'wingXSecShapes', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm', 'fuselageLength', 'guardedEpochV1'])
    const input = manifest([...MODELING_PROTOCOL_OPERATIONS, 'futureOperation'])
    expect(parseModelingProtocol(input)).toEqual({ status: 'valid', operations: [...MODELING_PROTOCOL_OPERATIONS] })
    expect(parseModelingProtocol(manifest([]))).toEqual({ status: 'valid', operations: [] })
  })

  it('rejects invalid envelope, unknown versions and malformed operations', () => {
    for (const value of [null, undefined, [], 'text', {}, { ...manifest(), protocol: 'other' }, { ...manifest(), version: 2 }, { ...manifest(), version: '1' }, manifest(null), manifest([1]), manifest(['']), manifest(['x'.repeat(257)]), manifest(Array(1025).fill('x'))]) {
      expect(parseModelingProtocol(value)).toEqual(invalid)
    }
    expect(parseModelingProtocol(manifest(['model', 'model']))).toEqual(invalid)
    expect(parseModelingProtocol(manifest(['unknown', 'unknown']))).toEqual(invalid)
    expect(parseModelingProtocol(manifest(['model', 1]))).toEqual(invalid)
  })

  it('does not call getters, and rejects inherited and sparse fields', () => {
    const getter = vi.fn(() => 'webvsp-modeling')
    expect(parseModelingProtocol({ get protocol() { return getter() }, version: 1, operations: [] })).toEqual(invalid)
    expect(getter).not.toHaveBeenCalled()
    expect(parseModelingProtocol(Object.assign(Object.create({ protocol: 'webvsp-modeling' }), { version: 1, operations: [] }))).toEqual(invalid)
    const ops = ['model']
    Object.defineProperty(ops, '0', { get: getter })
    expect(parseModelingProtocol(manifest(ops))).toEqual(invalid)
    expect(getter).not.toHaveBeenCalled()
    expect(parseModelingProtocol(manifest(Array(1)))).toEqual(invalid)
  })

  it('fails closed for throwing and revoked proxies', () => {
    expect(parseModelingProtocol(new Proxy(manifest(), { getOwnPropertyDescriptor() { throw Error('trap') } }))).toEqual(invalid)
    expect(parseModelingProtocol(manifest(new Proxy(['model'], { getOwnPropertyDescriptor() { throw Error('trap') } })))).toEqual(invalid)
    const proxy = Proxy.revocable([], {})
    proxy.revoke()
    expect(parseModelingProtocol(manifest(proxy.proxy))).toEqual(invalid)
  })

  it.each(['protocol', 'version', 'operations', 'length', '0', '1', '2'] as const)(
    'stops after the %s descriptor trap closes parsing, with or without a trap error', (closingKey) => {
      for (const throwAfterClose of [false, true]) {
        let closed = false
        const accessed: string[] = []
        const getter = vi.fn(() => 'model')
        const ops = ['model', 'bbox', 'origin']
        Object.defineProperty(ops, '2', { get: getter, configurable: true })
        const trap = (target: object, key: PropertyKey) => {
          accessed.push(String(key))
          if (key === closingKey) {
            closed = true
            if (throwAfterClose) throw new Error('descriptor trap error')
          }
          return Reflect.getOwnPropertyDescriptor(target, key)
        }
        const input = new Proxy(manifest(new Proxy(ops, { getOwnPropertyDescriptor: trap })), {
          getOwnPropertyDescriptor: trap,
        })
        const checkOpen = () => { if (closed) throw new Error('closed') }
        const order = ['protocol', 'version', 'operations', 'length', '0', '1', '2']

        // Neither a close check nor the trap's own error may escape the parser.
        expect(parseModelingProtocol(input, checkOpen)).toEqual(invalid)
        expect(accessed).toEqual(order.slice(0, order.indexOf(closingKey) + 1))
        expect(getter).not.toHaveBeenCalled()
      }
    },
  )

  it('protects the exported vocabulary from external mutation', () => {
    const original = [...MODELING_PROTOCOL_OPERATIONS]
    expect(Object.isFrozen(MODELING_PROTOCOL_OPERATIONS)).toBe(true)
    expect(() => (MODELING_PROTOCOL_OPERATIONS as unknown as string[]).push('bogus')).toThrow()
    expect(() => { (MODELING_PROTOCOL_OPERATIONS as unknown as string[])[0] = 'bogus' }).toThrow()
    expect(MODELING_PROTOCOL_OPERATIONS).toEqual(original)
    expect(parseModelingProtocol(manifest(['modelDiscovery', 'bogus']))).toEqual({ status: 'valid', operations: ['modelDiscovery'] })
  })

  it('returns independent operation arrays', () => {
    const value = manifest(['model', 'futureOperation'])
    const first = parseModelingProtocol(value)
    expect(first).toEqual({ status: 'valid', operations: ['model'] })
    first.operations.length = 0
    expect(parseModelingProtocol(value)).toEqual({ status: 'valid', operations: ['model'] })
  })
})
