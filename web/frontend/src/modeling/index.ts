import { api } from '../api/client'
import { createReadService } from './readService'

export * from './contracts'
export type { ModelingReadAdapter } from './readService'
export { createReadService } from './readService'

// One browser module owns one engine; multiple service handles share its session identity.
const sessionId = crypto.randomUUID()

/** Create a handle for this browser engine. Closing a handle does not stop the engine. */
export function createBrowserModelingService() {
  return createReadService({ model: api.model, bbox: api.bbox }, sessionId)
}
