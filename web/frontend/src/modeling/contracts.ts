/** Browser-local modeling contracts. These types contain no MCP or UI dependencies. */
export const MODELING_CONTRACT_VERSION = '0.1' as const

/** Identifies a model within an engine session; not a revision or persistence indicator. */
export interface ModelIdentity {
  sessionId: string
  modelEpoch: string
}

/** An engine event sequence, not a compare-and-set token or persistence indicator. */
export interface ModelContext {
  sessionId: string
  engineRevision: number
  engineVersion: string
}

export interface Geometry {
  id: string
  name: string
  type: string
  parentId: string | null
  childIds: string[]
  /** Membership in OpenVSP's shown set; draw mode can still prevent rendering. */
  shown: boolean
}

export interface ModelInfo {
  identity: ModelIdentity
  context: ModelContext
  fileName: string
  geometries: Geometry[]
  selectedGeometryIds: string[]
}

export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

export type CapabilityStatus = 'supported' | 'unsupported'
export type CapabilityName = 'model.read' | 'geometry.read' | 'geometry.create' | 'geometry.move' | 'parameter.read' | 'parameter.write' | 'wing.read' | 'wing.edit' | 'fuselage.read' | 'fuselage.edit' | 'assembly.attach'

export interface Capability {
  name: CapabilityName
  status: CapabilityStatus
  reason?: string
}

export type ModelingErrorCode = 'INVALID_ARGUMENT' | 'GEOMETRY_NOT_FOUND' | 'CROSS_SECTION_NOT_FOUND' | 'UNSUPPORTED_OPERATION' | 'ENGINE_ERROR' | 'SESSION_CLOSED' | 'OUTCOME_UNKNOWN' | 'STALE_MODEL'

export class ModelingError extends Error {
  readonly code: ModelingErrorCode
  readonly details?: Readonly<Record<string, string | number | boolean | null>>

  constructor(code: ModelingErrorCode, message: string, details?: Readonly<Record<string, string | number | boolean | null>>) {
    super(message)
    this.name = 'ModelingError'
    this.code = code
    this.details = details
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) }
  }
}
