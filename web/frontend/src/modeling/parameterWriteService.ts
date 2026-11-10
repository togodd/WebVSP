import { WasmEngineError } from '../api/wasmEngine'
import { ModelingError } from './contracts'

export type ParameterOwner = 'geometry' | 'crossSection'

/** The adapter must perform one scoped write and return the engine's readback. */
export interface ParameterWriteAdapter {
  set(owner: ParameterOwner, ownerId: string, parameterId: string, value: number): Promise<{ actual: number }>
}

export interface ParameterWriteInput {
  owner: ParameterOwner
  ownerId: string
  parameterId: string
  value: number
}

function validId(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f]/u.test(value)) return false
  try { encodeURIComponent(value); return true } catch { return false }
}

/**
 * Writes one scoped linkable parameter. This does not promise atomic rollback,
 * units, or compliance with every GUI/driver constraint. The engine readback is
 * a point-in-time observation, not isolation from concurrent edits. Never retry
 * automatically, particularly after an unknown outcome.
 */
export function createParameterWriteService(adapter: ParameterWriteAdapter) {
  return {
    async set(input: ParameterWriteInput): Promise<{ actual: number }> {
      if (!input || typeof input !== 'object' || (input.owner !== 'geometry' && input.owner !== 'crossSection') ||
          !validId(input.ownerId) || !validId(input.parameterId) || typeof input.value !== 'number' || !Number.isFinite(input.value)) {
        throw new ModelingError('INVALID_ARGUMENT', 'A valid owner, IDs and finite numeric value are required')
      }
      const { owner, ownerId, parameterId, value } = input
      let result: { actual: number }
      try {
        result = await adapter.set(owner, ownerId, parameterId, value)
      } catch (error) {
        if (error instanceof WasmEngineError) {
          const actual = typeof error.actual === 'number' && Number.isFinite(error.actual) ? error.actual : null
          if (error.outcome === 'not_written') {
            throw new ModelingError('ENGINE_ERROR', 'The parameter was not written', { outcome: 'not_written', actual })
          }
          throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write may have changed the model; do not automatically retry', { outcome: error.outcome === 'different' ? 'different' : 'unknown', actual })
        }
        throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write outcome is unknown; do not automatically retry')
      }
      if (!result || typeof result.actual !== 'number' || !Number.isFinite(result.actual) || result.actual !== value) {
        throw new ModelingError('OUTCOME_UNKNOWN', 'The parameter write outcome is unknown; do not automatically retry')
      }
      return { actual: result.actual }
    },
  }
}
