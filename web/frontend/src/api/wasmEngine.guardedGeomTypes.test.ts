import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { GuardedOp } from './wasmEngine'

let bridge: typeof import('./wasmEngine')
beforeAll(async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } })
  bridge = await import('./wasmEngine')
})

describe('internal guarded geomTypes', () => {
  it('keeps the engine and TypeScript operation allowlists in sync', () => {
    const source = readFileSync(new URL('../../../wasm/engine/engine.cpp', import.meta.url), 'utf8')
    const body = source.match(/bool GuardedOpAllowed\( const string &op \)\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(body).toBeDefined()
    const engineOps = [...body!.matchAll(/op == "([^"]+)"/g)].map(match => match[1])
    expect(new Set(engineOps)).toEqual(new Set(bridge.GUARDED_OPS))
    expect(engineOps).toContain('geomTypes')
  })

  it('accepts geomTypes at the bridge but still rejects unlisted operations', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(bridge.callGuarded('geomTypes', '', '', 0, '1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(bridge.callGuarded('newModel' as GuardedOp, '', '', 0, '1', controller.signal)).rejects.toMatchObject({ message: 'Operation is not permitted by the guarded bridge' })
  })
})
