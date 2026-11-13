// Real GUI regression against an isolated copy of the host frontend and a production WASM.
// Run from web/frontend with WEBVSP_TEST_CHROMIUM, WEBVSP_TEST_WASM_DIR and
// WEBVSP_TEST_NODE_MODULES set to trusted test inputs. Linux process groups required.
// Browser routing is defense in depth, not an OS network sandbox. Process groups do
// not provide containment: an exited leader or escaped descendant can evade cleanup;
// run in a disposable OS-level container/cgroup when strict isolation is required.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, writeFile, rm, realpath, lstat } from 'node:fs/promises'
import { createReadStream, realpathSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const chromiumPath = process.env.WEBVSP_TEST_CHROMIUM
if (!chromiumPath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const source = resolve('.')
const artifact = process.env.WEBVSP_TEST_WASM_DIR
const dependencies = process.env.WEBVSP_TEST_NODE_MODULES
if (!artifact || !dependencies) throw new Error('Set WEBVSP_TEST_WASM_DIR and WEBVSP_TEST_NODE_MODULES')
let temp, tempReal, server, chromeProcess, browser, context
let serverOutput = '', chromeOutput = ''
const killGroup = (child, signal) => {
  if (!child?.pid) return
  if (child.exitCode !== null || child.signalCode !== null) {
    console.error('Leader already exited; descendant group status is unknown:', child.pid)
    return
  }
  try { process.kill(-child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') console.error('Process group kill failed:', e) }
}
const timeoutMs = Number(process.env.WEBVSP_TEST_TIMEOUT_MS ?? 180000)
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000)
const watchdog = setTimeout(() => {
  console.error('Global timeout: killing owned process groups')
  killGroup(chromeProcess, 'SIGKILL'); killGroup(server, 'SIGKILL')
  // Abrupt exit cannot await cleanup. Never follow or remove an unverified path.
  try {
    if (temp && tempReal && realpathSync(temp) === tempReal && tempReal.startsWith(join(realpathSync(tmpdir()), 'webvsp-clone-gui-'))) {
      rmSync(tempReal, { recursive: true }); console.error('Removed temporary frontend after timeout:', tempReal)
    }
  } catch (e) { console.error('Timeout cleanup failed:', e) }
  process.exit(1)
}, timeoutMs)
try {
temp = await mkdtemp(join(tmpdir(), 'webvsp-clone-gui-'))
tempReal = await realpath(temp)
assert.equal(tempReal, temp, 'temporary directory must resolve to its created absolute path')
const wasmPath = join(artifact, 'vsp.wasm')
const hash = createHash('sha256')
for await (const chunk of createReadStream(wasmPath)) hash.update(chunk)
console.log('WASM SHA-256:', hash.digest('hex'))
const frontend = join(temp, 'frontend')
console.log('Temporary frontend:', frontend)
await cp(source, frontend, { recursive: true, filter: async p => {
  if (['node_modules', 'dist', '.git'].includes(p.split('/').at(-1))) return false
  if ((await lstat(p)).isSymbolicLink()) throw new Error(`Refusing source symlink: ${p}`)
  return true
} })
// Independent copied dependencies: Vite must never write into the user's node_modules.
await cp(dependencies, join(frontend, 'node_modules'), { recursive: true, dereference: true })
await mkdir(join(frontend, 'public', 'wasm'), { recursive: true })
await cp(artifact, join(frontend, 'public', 'wasm'), { recursive: true })
const token = randomBytes(32).toString('hex')
// The server binds port 0 itself; do not probe and release a port before launching it.
// The token endpoint is injected into this private Vite instance, not the copied app.
await writeFile(join(frontend, 'vite.clone-test.config.mjs'), `import config from './vite.config.ts'\nexport default { ...config, cacheDir: ${JSON.stringify(join(temp, 'vite-cache'))}, plugins: [...(config.plugins ?? []), { name: 'isolated-test-token', configureServer(server) { server.middlewares.use('/__clone_test_token', (_req, res) => { res.setHeader('Content-Type', 'text/plain'); res.end(${JSON.stringify(token)}) }); server.middlewares.use('/__clone_test_redirect', (_req, res) => { res.statusCode = 302; res.setHeader('Location', '/__clone_test_redirect_target'); res.end() }); server.middlewares.use('/__clone_test_redirect_target', (_req, res) => { res.end('REDIRECT_REACHED') }) } }] }\n`)
let origin
server = spawn(process.execPath, [join(frontend, 'node_modules/vite/bin/vite.js'), '--config', 'vite.clone-test.config.mjs', '--host', '127.0.0.1', '--port', '0', '--strictPort'], { cwd: frontend, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let spawnError
server.on('error', e => { spawnError = e })
server.stdout.on('data', b => { serverOutput += b.toString() })
server.stderr.on('data', b => { serverOutput += b.toString() })
  for (let i = 0; i < 150; i++) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Vite exited: ${serverOutput}`)
    const match = /Local:\s+(http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(serverOutput)
    if (match && Number(match[2]) > 0) { origin = new URL(match[1]).origin; break }
    if (i === 149) throw new Error(`Vite did not report its bound address: ${serverOutput}`)
    await new Promise(r => setTimeout(r, 200))
  }
  const tokenResponse = await fetch(`${origin}/__clone_test_token`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  assert.equal(tokenResponse.status, 200, 'private Vite token endpoint must answer directly')
  assert.equal(await tokenResponse.text(), token, 'bound server must be the spawned private Vite instance')
  assert.equal(server.exitCode, null, 'Vite must still be running after identity verification')
  console.log('Verified isolated Vite origin:', origin)
  chromeProcess = spawn(chromiumPath, ['--headless', '--no-sandbox', '--enable-unsafe-swiftshader', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(temp, 'chromium-profile')}`, 'about:blank'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let chromeError
  chromeProcess.on('error', e => { chromeError = e })
  chromeProcess.stdout.on('data', b => { chromeOutput += b.toString() })
  chromeProcess.stderr.on('data', b => { chromeOutput += b.toString() })
  let endpoint
  for (let i = 0; i < 150; i++) {
    if (chromeError) throw chromeError
    if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) throw new Error(`Chromium exited: ${chromeOutput}`)
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(chromeOutput)
    if (match) { endpoint = match[1]; break }
    await new Promise(r => setTimeout(r, 200))
  }
  if (!endpoint) throw new Error(`Chromium did not report its debugging endpoint: ${chromeOutput}`)
  browser = await chromium.connectOverCDP(endpoint)
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('download', () => errors.push('unexpected download'))
  page.on('response', r => { if (r.status() >= 300 && r.status() < 400) errors.push(`redirect: ${r.url()}`) })
  const safeRoute = async route => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() !== 'GET' || url.origin !== origin || req.redirectedFrom()) return route.abort()
    const response = await route.fetch({ maxRedirects: 0 })
    if (response.status() >= 300 && response.status() < 400) return route.abort()
    return route.fulfill({ response })
  }
  await context.route('**/*', safeRoute)
  const redirectTargetRequests = []
  page.on('request', r => { if (r.url().includes('/__clone_test_redirect_target')) redirectTargetRequests.push(r.url()) })
  const redirectResult = await page.goto(`${origin}/__clone_test_redirect`).then(() => 'loaded', () => 'blocked')
  assert.equal(redirectResult, 'blocked', 'redirect response must be aborted')
  assert.deepEqual(redirectTargetRequests, [], 'redirect target must never be requested')
  console.log('Redirect blocked before target request')
  await page.addInitScript(() => {
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) Object.defineProperty(window, key, { value: async () => { throw new DOMException('Disabled by test', 'AbortError') } })
  })
  // Prewarm Vite in a disposable context. Optimizer-triggered reloads must finish
  // before the fresh context used for the isolated model is created.
  const warmContext = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
  await warmContext.route('**/*', safeRoute)
  const warm = await warmContext.newPage()
  await warm.addInitScript(() => {
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) Object.defineProperty(window, key, { value: async () => { throw new DOMException('Disabled by test', 'AbortError') } })
  })
  await warm.goto(origin, { waitUntil: 'domcontentloaded' })
  await warm.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  await warm.waitForTimeout(3000)
  await warmContext.close()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const model = () => page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  const identity = () => page.evaluate(async () => (await window.__webvspModelingReadV1.model.getInfo()).identity)
  const initialIdentity = await identity()
  assert.ok(initialIdentity.sessionId, 'independent engine session must have an identity')
  const empty = await model()
  assert.equal(initialIdentity.modelEpoch, empty.modelEpoch)
  assert.equal(empty.geoms.length, 0, 'independent page must start empty')
  assert.equal(empty.modelEpochValid, true)
  const choice = page.locator('select').filter({ has: page.locator('option:text-is("WING")') }).first()
  await choice.selectOption({ label: 'WING' })
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForFunction(() => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === 1), null, { timeout: 30000 })
  const wing = await model()
  console.log('After GUI Add Wing:', JSON.stringify(wing))
  assert.equal(wing.geoms[0].type.toUpperCase(), 'WING')
  await page.getByRole('button', { name: 'Clone', exact: true }).first().click()
  await page.getByRole('button', { name: 'Clone', exact: true }).last().click()
  await page.waitForFunction(() => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.length === 2), null, { timeout: 30000 })
  const before = await model()
  console.log('After GUI Clone:', JSON.stringify(before))
  const clone = before.geoms.find(g => g.id !== wing.geoms[0].id)
  assert.ok(clone)
  assert.equal(clone.type.toUpperCase(), 'CLONE')
  // Cloning selects the new geom but does not open its editor; select its tree row.
  const cloneRow = page.locator('.m-tlabel').filter({ hasText: clone.name }).first()
  await cloneRow.waitFor({ state: 'visible', timeout: 30000 })
  await cloneRow.click()
  await page.waitForFunction(id => window.__webvspEngine.request('GET', '/model').then(m => m.active.length === 1 && m.active[0] === id), clone.id, { timeout: 30000 })
  // The editor appears asynchronously after selection. Replace belongs to the Clone tab,
  // not the inherited Gen tab. Exercise the actual mirrored tab event, not a direct API.
  const cloneTab = page.locator('.m-tab').filter({ hasText: /^Clone$/ })
  await cloneTab.waitFor({ state: 'visible', timeout: 30000 })
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('.m-tab')].map(e => ({ text: e.textContent, active: e.classList.contains('on') })))
  console.log('English editor tabs before activation:', JSON.stringify(await tabs()))
  await cloneTab.click()
  await page.waitForFunction(() => [...document.querySelectorAll('.m-tab.on')].some(e => e.textContent === 'Clone'))
  const replace = page.getByRole('button', { name: 'Replace With Copy Of Original', exact: true })
  await replace.waitFor({ state: 'visible', timeout: 30000 })
  await replace.click()
  await page.waitForFunction(id => window.__webvspEngine.request('GET', '/model').then(m => m.geoms.some(g => g.id === id && g.type.toUpperCase() === 'WING')), clone.id, { timeout: 30000 })
  const after = await model()
  console.log('After GUI Replace:', JSON.stringify(after))
  assert.deepEqual(await identity(), initialIdentity, 'same session and model epoch after replacing the object')
  assert.equal(after.modelEpochValid, true)
  assert.equal(after.modelEpoch, before.modelEpoch)
  assert.equal(before.modelEpoch, empty.modelEpoch)
  assert.equal(after.geoms.find(g => g.id === clone.id)?.type.toUpperCase(), 'WING')
  assert.deepEqual(errors, [])
  console.log(`PASS: epoch=${before.modelEpoch} geom=${clone.id} changed CLONE -> WING via GUI; same ID does not guarantee the same object instance`)
} finally {
  const cleanupErrors = []
  const bounded = async (name, action, ms = 3000) => {
    let timer
    try { await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms) })]) }
    catch (e) { cleanupErrors.push(`${name}: ${e.message}`) }
    finally { clearTimeout(timer) }
  }
  // Kill each owned group while its group leader is still alive; waiting for graceful
  // browser.close() first could lose the group after leader exit. Never signal a stale
  // group ID: if a leader has already exited, descendants cannot be safely identified.
  for (const [name, child] of [['Chromium', chromeProcess], ['Vite', server]]) {
    if (!child) continue
    if (child.pid && (child.exitCode !== null || child.signalCode !== null)) {
      cleanupErrors.push(`${name} leader exited before cleanup; descendant group status is unknown`)
      continue
    }
    killGroup(child, 'SIGKILL')
    await bounded(`${name} exit`, () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve()
      child.once('exit', resolve)
    }), 4000)
  }
  // Group kill closes CDP; no Playwright close is needed or awaited afterward.
  console.log('Vite output:', serverOutput.trim())
  if (temp) await bounded('remove private temporary directory', async () => {
    const actual = await realpath(temp)
    assert.equal(actual, tempReal, 'only remove our unchanged temporary directory')
    assert.ok(actual.startsWith(join(await realpath(tmpdir()), 'webvsp-clone-gui-')))
    await rm(actual, { recursive: true })
    console.log('Removed temporary frontend:', actual)
  }, 10000)
  if (cleanupErrors.length) {
    console.error(`Cleanup failed (timed-out operations may still be running): ${cleanupErrors.join('; ')}`)
    process.exitCode = 1
    // Keep watchdog armed; bounded Promise.race does not cancel pending operations.
  } else {
    clearTimeout(watchdog)
  }
}
