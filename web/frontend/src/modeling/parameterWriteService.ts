import { WasmEngineError } from '../api/wasmEngine'
import { ModelingError, type ModelIdentity } from './contracts'
import { raceClose } from './readService'

export type ParameterOwner = 'geometry' | 'crossSection'

/** The adapter must perform one scoped write and return the engine's readback. */
export interface ParameterWriteAdapter {
  set(owner: ParameterOwner, ownerId: string, parameterId: string, value: number, identity?: ModelIdentity): Promise<{ actual: number }>
}

export interface ParameterWriteInput {
  owner: ParameterOwner
  ownerId: string
  parameterId: string
  value: number
}

function validId(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /\s/u.test(value) || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false
  try { encodeURIComponent(value); return true } catch { return false }
}

/**
 * Writes one scoped linkable parameter. This does not promise atomic rollback,
 * units, or compliance with every GUI/driver constraint. The engine readback is
 * a point-in-time observation, not isolation from concurrent edits. Never retry
 * automatically, particularly after an unknown outcome.
 */
export function createParameterWriteService(adapter: ParameterWriteAdapter, signal: AbortSignal = new AbortController().signal) {
  return {
    async set(input: ParameterWriteInput, identity?: ModelIdentity): Promise<{ actual: number }> {
      if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
      let owner: ParameterOwner, ownerId: string, parameterId: string, value: number
      let identityCopy: ModelIdentity | undefined
      try {
        if (!input || typeof input !== 'object') throw new Error()
        ;({ owner, ownerId, parameterId, value } = input)
        if ((owner !== 'geometry' && owner !== 'crossSection') || !validId(ownerId) || !validId(parameterId) ||
            typeof value !== 'number' || !Number.isFinite(value)) throw new Error()
        if (identity !== undefined) {
          if (!identity || typeof identity !== 'object') throw new Error()
          const { sessionId, modelEpoch } = identity
          if (typeof sessionId !== 'string' || !sessionId || typeof modelEpoch !== 'string' || !modelEpoch) throw new Error()
          identityCopy = { sessionId, modelEpoch }
        }
      } catch {
        if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
        throw new ModelingError('INVALID_ARGUMENT', 'A valid owner, IDs and finite numeric value are required')
      }
      if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
      let dispatched = false
      let result: { actual: number }
      try {
        result = await raceClose(signal, () => {
          const method = adapter.set
          // Accessors can synchronously close the session before the write starts.
          if (signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
          dispatched = true
          return Reflect.apply(method, adapter, identityCopy === undefined ? [owner, ownerId, parameterId, value] : [owner, ownerId, parameterId, value, { ...identityCopy }])
        })
        if (signal.aborted) throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write outcome is unknown; do not automatically retry')
      } catch (error) {
        if (!dispatched && signal.aborted) throw new ModelingError('SESSION_CLOSED', 'Modeling session is closed')
        if (signal.aborted) throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write outcome is unknown; do not automatically retry')
        if (error instanceof WasmEngineError) {
          let actual: number | null = null
          try {
            const readback = error.actual
            if (typeof readback === 'number' && Number.isFinite(readback)) actual = readback
          } catch {
            throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write outcome is unknown; do not automatically retry')
          }
          if (error.outcome === 'not_written') {
            if (identity !== undefined && error.code === 'STALE_MODEL') throw new ModelingError('STALE_MODEL', 'The model identity is stale', { outcome: 'not_written', actual })
            throw new ModelingError('ENGINE_ERROR', 'The parameter was not written', { outcome: 'not_written', actual })
          }
          throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write may have changed the model; do not automatically retry', { outcome: error.outcome === 'different' ? 'different' : 'unknown', actual })
        }
        throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write outcome is unknown; do not automatically retry')
      }
      try {
        const actual = result?.actual
        if (!signal.aborted && typeof actual === 'number' && Number.isFinite(actual) && actual === value) return { actual }
      } catch {
        // A throwing readback cannot establish the outcome of a dispatched write.
      }
      throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write outcome is unknown; do not automatically retry')
    },
  }
}
