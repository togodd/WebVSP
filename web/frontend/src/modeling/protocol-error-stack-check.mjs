// Real WASM fault regression; ONLY an isolated disposable engine compiled with
// WEBVSP_SCRIPT_GUARD_TEST. Never deploy it or use a real model/profile.
// Serve with vite.modeling-test.config.ts, then from web/frontend run:
// WEBVSP_TEST_CHROMIUM=/path/to/chromium node src/modeling/protocol-error-stack-check.mjs
// WEBVSP_TEST_PAGE defaults to http://127.0.0.1:5179/.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const deadline = setTimeout(() => { console.error('FAIL: protocol error stack test timed out'); process.exit(1) }, 180000)
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const response = await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  assert.ok(response?.ok(), 'test page must load')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required')
    const engine = window.__webvspEngine
    if (typeof engine?.testCall !== 'function') throw new Error('DEV testCall unavailable')
    return engine.testCall('protocolErrorStackProbe')
  })
  const { protocol, control, firstCode, secondCode } = result
  assert.notEqual(firstCode, secondCode, 'distinct sentinel error codes')
  assert.equal(protocol.before, 2, 'two errors injected before protocol')
  assert.equal(protocol.after, 2, 'protocol preserves stack count')
  assert.deepEqual(protocol.errors, [
    { code: secondCode, message: 'protocol sentinel second' },
    { code: firstCode, message: 'protocol sentinel first' },
  ], 'protocol preserves both error codes, messages and LIFO order')
  assert.deepEqual(protocol.reply, { t: 'result', id: -2147483000, ok: true, value: {
    protocol: 'webvsp-modeling', version: 1, operations: [
      'modelDiscovery', 'model', 'bbox', 'origin', 'geomXSecs', 'fuselageXSecShapes',
      'wingXSecShapes', 'geomParmIDs', 'xsecParmIDs', 'geomParm', 'xsecParm',
      'fuselageLength', 'guardedEpochV1',
    ],
  } }, 'nested real protocol response')
  assert.equal(control.before, 2, 'control injected same sentinels')
  assert.equal(control.after, 0, 'normal request entry clears stack (positive control)')
  assert.deepEqual(control.errors, [])
  assert.deepEqual(control.reply, { t: 'result', id: -2147483000, ok: false, error: 'unknown request: webvspDefinitelyUnknownOperation' })
  assert.deepEqual(errors, [])
  console.log('PASS: modelingProtocol preserves both existing API errors; ordinary operation clears them')
} finally {
  if (browser) await browser.close()
  clearTimeout(deadline)
}
