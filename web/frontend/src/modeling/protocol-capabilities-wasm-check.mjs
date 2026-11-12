// Real WASM declared-capabilities regression against the existing isolated Vite server.
// From web/frontend: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/modeling/protocol-capabilities-wasm-check.mjs
// WEBVSP_TEST_PAGE overrides http://127.0.0.1:5179/; WEBVSP_EXPECT_OLD_ENGINE=1 expects ENGINE_ERROR.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const oldEngine = process.env.WEBVSP_EXPECT_OLD_ENGINE === '1'
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const result = await page.evaluate(async () => {
    const { createBrowserModelingService } = await import('/src/modeling/index.ts')
    const engine = window.__webvspEngine
    if (typeof engine?.testCall !== 'function') throw new Error('Dev test hook unavailable')
    const capture = async fn => {
      try { return { value: await fn() } }
      catch (error) { return { error: { code: error?.code, message: error?.message, status: error?.status } } }
    }
    const a = createBrowserModelingService()
    const b = createBrowserModelingService()
    try {
      const capabilitiesBefore = a.capabilities()
      const raw = await capture(() => engine.testCall('modelingProtocol'))
      const first = await capture(() => a.declaredCapabilities())
      const firstSnapshot = structuredClone(first)
      const second = await capture(() => a.declaredCapabilities())
      const other = await capture(() => b.declaredCapabilities())
      let independent = null
      if (first.value && second.value && other.value) {
        const snapshot = structuredClone(second.value)
        independent = {
          arrays: first.value !== second.value && first.value !== other.value,
          entries: first.value.every((item, i) => item !== second.value[i] && item !== other.value[i]),
          missingArrays: first.value.every((item, i) => item.missingOperations === null ||
            (item.missingOperations !== second.value[i].missingOperations && item.missingOperations !== other.value[i].missingOperations)),
        }
        first.value[0].missingOperations.push('origin')
        first.value[1].status = 'unknown'
        first.value.pop()
        independent.secondUnchanged = JSON.stringify(second.value) === JSON.stringify(snapshot)
        independent.otherUnchanged = JSON.stringify(other.value) === JSON.stringify(snapshot)
      }
      const afterMutation = await capture(() => a.declaredCapabilities())
      const capabilitiesAfter = a.capabilities()
      a.close()
      const closed = await capture(() => a.declaredCapabilities())
      const survivor = await capture(() => b.declaredCapabilities())
      return { capabilitiesBefore, capabilitiesAfter, raw, firstSnapshot, second, other, independent, afterMutation, closed, survivor }
    } finally { a.close(); b.close() }
  })
  const names = ['model.read', 'geometry.read', 'geometry.create', 'geometry.move', 'parameter.read', 'parameter.write', 'wing.read', 'wing.edit', 'fuselage.read', 'fuselage.edit', 'assembly.attach']
  const reads = new Set(['model.read', 'geometry.read', 'parameter.read', 'wing.read', 'fuselage.read'])
  const capabilities = {
    contractVersion: '0.1',
    features: names.map(name => reads.has(name) ? { name, status: 'supported' } : {
      name, status: 'unsupported', reason: ['geometry.create', 'geometry.move', 'parameter.write'].includes(name)
        ? 'Disabled pending reentrancy safety review' : 'Not implemented or not verified',
    }),
  }
  assert.deepEqual(result.capabilitiesBefore, capabilities, 'existing capabilities contract')
  assert.deepEqual(result.capabilitiesAfter, capabilities, 'declaredCapabilities must not change capabilities')
  assert.equal(result.closed.error?.code, 'SESSION_CLOSED')
  const calls = [result.firstSnapshot, result.second, result.other, result.afterMutation, result.survivor]
  if (oldEngine) {
    assert.equal(result.raw.error?.message, 'unknown request: modelingProtocol', 'verify this is the old WASM')
    assert.equal(result.raw.error?.status, 400)
    for (const call of calls) assert.equal(call.error?.code, 'ENGINE_ERROR', JSON.stringify(call))
  } else {
    assert.deepEqual(result.raw.value, { protocol: 'webvsp-modeling', version: 1, operations: [
      'modelDiscovery', 'model', 'geomTypes', 'bbox', 'origin', 'geomXSecs', 'fuselageXSecShapes',
      'wingXSecShapes', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm',
      'fuselageLength', 'guardedEpochV1',
    ] }, 'complete production WASM manifest')
    const expected = names.map(name => reads.has(name)
      ? { name, status: 'declared', missingOperations: [] }
      : { name, status: 'unknown', missingOperations: null })
    for (const call of calls) assert.deepEqual(call, { value: expected }, 'exact declaration-derived capabilities')
    assert.deepEqual(result.independent, { arrays: true, entries: true, missingArrays: true, secondUnchanged: true, otherUnchanged: true }, 'fresh independent results')
  }
  assert.deepEqual(errors, [])
  console.log(`PASS: ${oldEngine ? 'old WASM produces ENGINE_ERROR' : 'complete WASM declaration yields five declared reads and unknown remainder'}; close, independent handles and unchanged capabilities`)
} finally {
  await browser.close()
}
