// Production-browser stress regression for the engine request queue.
// Runs only against the built page; it never edits engine.cpp or uses test-only hooks.
// Usage: WEBVSP_URL=http://127.0.0.1:4173/ CHROMIUM_PATH=... node scripts/queue-fairness-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4173/'
const executablePath = process.env.CHROMIUM_PATH ?? process.env.WEBVSP_TEST_CHROMIUM
const total = Number(process.env.WEBVSP_QUEUE_REQUESTS ?? 128)
const timeoutMs = Number(process.env.WEBVSP_QUEUE_TIMEOUT_MS ?? 120_000)
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const started = Date.now()
const failures = []
let page
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(new URL(base).href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForSelector('[data-ready="1"]', { timeout: timeoutMs })
  await page.waitForFunction(() => typeof globalThis.__webvspEngine?.request === 'function', null, { timeout: 30_000 })

  // Start all calls in one browser turn. Mixed read/write work makes this a real queue load,
  // while the disposable browser context keeps the user's model untouched.
  await page.evaluate(({ total }) => {
    globalThis.__queueStress = (async () => {
    const api = globalThis.__webvspEngine.request
    const launched = []
    const completed = []
    const startedAt = performance.now()
    const jobs = Array.from({ length: total }, (_, index) => {
      const slot = index + 1
      const kind = slot % 4 === 1 ? 'addGeom' : slot % 4 === 2 ? 'model' : slot % 4 === 3 ? 'bbox' : 'geomTypes'
      const method = kind === 'addGeom' ? 'POST' : 'GET'
      const path = kind === 'addGeom' ? '/geoms' : kind === 'model' ? '/model' : kind === 'bbox' ? '/bbox/all' : '/geom-types'
      const body = kind === 'addGeom' ? { type: 'WING' } : undefined
      launched.push({ slot, kind })
      return api(method, path, body).then(value => {
        completed.push({ slot, kind, ok: true })
        return { slot, kind, value }
      }, error => {
        completed.push({ slot, kind, ok: false, error: String(error?.message ?? error) })
        throw error
      })
    })
    const settled = await Promise.allSettled(jobs)
    const finalModel = await api('GET', '/model')
    const elapsedMs = performance.now() - startedAt
    return { launched, completed, settled: settled.map(item => item.status), finalModel, elapsedMs }
    })().then(value => { globalThis.__queueStressResult = { value } }, error => { globalThis.__queueStressResult = { error: String(error?.stack ?? error) } })
  }, { total })
  await page.getByRole('button', { name: 'Analysis', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /CompGeom/ }).click({ timeout: 30_000 })
  await page.locator('.m-float').filter({ has: page.locator('.m-float-title', { hasText: /Comp\s*Geom/i }) }).first().waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => !!globalThis.__queueStressResult, null, { timeout: timeoutMs })
  const outcome = await page.evaluate(() => globalThis.__queueStressResult)
  assert(!outcome.error, outcome.error)
  const report = outcome.value
  assert(report.completed.some(item => item.slot > 0), 'requests completed')

  assert.equal(report.launched.length, total, 'all requests were launched')
  assert.equal(report.completed.length, total, 'all requests produced a completion callback')
  assert(report.settled.every(status => status === 'fulfilled'), `request failures: ${report.settled.filter(status => status !== 'fulfilled').length}`)
  assert.deepEqual(report.completed.map(item => item.slot), report.launched.map(item => item.slot), 'completion order is FIFO')
  const expectedWings = Math.floor((total + 3) / 4)
  const actualWings = report.finalModel?.geoms?.length ?? -1
  assert.equal(actualWings, expectedWings, `all addGeom operations committed (expected ${expectedWings}, got ${actualWings})`)
  assert(report.finalModel && Array.isArray(report.finalModel.geoms), 'final model response is valid')
  assert.equal(pageErrors.length, 0, `browser page errors: ${pageErrors.slice(0, 3).join('; ')}`)

  // A GUI-facing check after the queue drains: the mirror is still rendered and the page remains
  // interactive. This intentionally tests responsiveness, not an absolute latency guarantee.
  const ready = await page.locator('[data-ready="1"]').count()
  const bodyText = await page.locator('body').innerText()
  assert.equal(ready, 1, 'GUI ready marker remains present')
  assert(bodyText.length > 0, 'GUI has rendered content after stress')

  const elapsed = Date.now() - started
  console.log(JSON.stringify({
    pass: true,
    requests: total,
    expectedWings,
    actualGeoms: actualWings,
    fifo: true,
    allCompleted: true,
    guiReady: true,
    elapsedMs: Math.round(elapsed),
    queueElapsedMs: Math.round(report.elapsedMs),
    note: 'Bounded regression evidence only; no absolute latency guarantee.',
  }, null, 2))
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(JSON.stringify({ pass: false, failures, elapsedMs: Date.now() - started }, null, 2))
  process.exitCode = 1
} finally {
  await browser.close()
}
