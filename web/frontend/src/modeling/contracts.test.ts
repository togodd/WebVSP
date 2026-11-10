import { describe, expect, it } from 'vitest'
import { MODELING_CONTRACT_VERSION, ModelingError } from './contracts'

describe('modeling contracts', () => {
  it('uses a separately versioned contract', () => {
    expect(MODELING_CONTRACT_VERSION).toBe('0.1')
  })

  it('serializes stable errors without a stack trace', () => {
    const error = new ModelingError('INVALID_ARGUMENT', 'Invalid geometry', { field: 'geometryId' })
    expect(error).toBeInstanceOf(Error)
    expect(JSON.parse(JSON.stringify(error))).toEqual({ code: 'INVALID_ARGUMENT', message: 'Invalid geometry', details: { field: 'geometryId' } })
  })

  it('does not include absent details', () => {
    expect(JSON.parse(JSON.stringify(new ModelingError('ENGINE_ERROR', 'Unavailable')))).toEqual({ code: 'ENGINE_ERROR', message: 'Unavailable' })
  })
})
