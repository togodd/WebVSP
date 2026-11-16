// Run only against a served built WebVSP app; P1 uses disposable fixed models.
import { chromium } from 'playwright-core'
const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:8090/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const errors = [], external = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  const url = new URL(base); url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__runP1AnalysisProbe === 'function')
  const created = await page.evaluate(() => window.__webvspEngine.request('POST', '/geoms', { type: 'WING' }))
  if (!created?.id) throw new Error('Unable to create a disposable page-model wing')
  const before = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  // Leave the real worker intact, but direct its program import to a missing
  // same-origin directory. The worker itself must report the actual import failure.
  const fault = await page.evaluate(async () => {
    const NativeWorker = window.Worker
    const evidence = { constructed: 0, posted: 0, failedMessages: 0, terminated: 0, programUrl: '', failure: '', concurrentError: '' }
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        this.isFaultWorker = String(url).includes('p1ProgramWorker') && evidence.constructed === 0
        if (this.isFaultWorker) {
          evidence.constructed++
          this.addEventListener('message', ({ data }) => { if (data?.type === 'failed') evidence.failedMessages++ })
        }
      }
      postMessage(message, ...rest) {
        if (this.isFaultWorker) {
          evidence.posted++
          const base = new URL(`p1-intentionally-missing-${Date.now()}/`, message.base).href
          evidence.programUrl = new URL('wasm/vsp_p1_analysis.js', base).href
          return super.postMessage({ ...message, base }, ...rest)
        }
        return super.postMessage(message, ...rest)
      }
      terminate() {
        if (this.isFaultWorker) evidence.terminated++
        return super.terminate()
      }
    }
    try {
      const failed = window.__runP1AnalysisProbe().then(() => 'unexpected success', e => e.message)
      evidence.concurrentError = await window.__runP1AnalysisProbe().then(() => '', e => e.message)
      evidence.failure = await failed
      return evidence
    } finally { window.Worker = NativeWorker }
  })
  if (fault.constructed !== 1 || fault.posted !== 1 || fault.failedMessages !== 1 || fault.terminated !== 1 || !fault.failure.includes(fault.programUrl) || !fault.concurrentError.includes('already running')) throw new Error(`P1 program load fault was not handled: ${JSON.stringify(fault)}`)
  const afterFault = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  if (JSON.stringify(before) !== JSON.stringify(afterFault)) throw new Error('Page model changed after worker load failure')
  // Wrap the generated program factory for one run only. The real WASM module
  // initializes, then its callMain wrapper signals entry and spins in synthetic
  // JS, not native OpenVSP code. A separate channel avoids a protocol message.
  let injected = 0
  const programRoute = '**/wasm/vsp_p1_analysis.js'
  const injectProgram = async route => {
    if (injected) return route.continue()
    const response = await route.fetch()
    const source = await response.text()
    const marker = 'export default createP1Analysis;'
    if (!response.ok() || !source.includes(marker) || source.split(marker).length !== 2) throw new Error('Cannot inject P1 callMain wrapper into generated program')
    const wrapped = source.replace(marker, `export default async function(options) {
      const program = await createP1Analysis(options);
      const original = program.callMain;
      program.callMain = function(...args) {
        new BroadcastChannel('p1-smoke-callmain').postMessage('entered');
        while (true) { /* synthetic compute, terminated by the host */ }
        return original.apply(this, args);
      };
      return program;
    };`)
    injected++
    await route.fulfill({ response, body: wrapped })
  }
  await page.route(programRoute, injectProgram)
  const timeout = await page.evaluate(async () => {
    const NativeWorker = window.Worker, nativeSetTimeout = window.setTimeout
    const evidence = { constructed: 0, posted: 0, messages: 0, enteredCallMain: 0, terminated: 0, accelerated: 0, failure: '', concurrentError: '', compute: 'synthetic-js-loop-after-wasm-initialization' }
    let armed = false, worker, fireTimeout, acceleratedTimer
    const channel = new BroadcastChannel('p1-smoke-callmain')
    channel.onmessage = ({ data }) => {
      if (data !== 'entered' || !fireTimeout || evidence.enteredCallMain) return
      evidence.enteredCallMain++
      acceleratedTimer = nativeSetTimeout(fireTimeout, 100)
    }
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        this.isSilentWorker = String(url).includes('p1ProgramWorker') && evidence.constructed === 0
        if (this.isSilentWorker) {
          worker = this
          evidence.constructed++
          armed = true
          this.addEventListener('message', () => evidence.messages++)
        }
      }
      postMessage(message, ...rest) {
        if (this.isSilentWorker) evidence.posted++
        return super.postMessage(message, ...rest)
      }
      terminate() {
        if (this.isSilentWorker) { evidence.terminated++; evidence.enteredAtTermination = evidence.enteredCallMain }
        return super.terminate()
      }
    }
    window.setTimeout = function (callback, delay, ...args) {
      if (armed && delay === 120_000) {
        armed = false
        evidence.accelerated++
        fireTimeout = () => callback(...args)
        // Retain the actual host timer; entry schedules its original callback sooner.
        return nativeSetTimeout.call(window, callback, delay, ...args)
      }
      return nativeSetTimeout.call(window, callback, delay, ...args)
    }
    let watchdog
    try {
      const timed = window.__runP1AnalysisProbe().then(() => 'unexpected success', e => e.message)
      // The timer is registered synchronously; do not alter any other page timers.
      window.setTimeout = nativeSetTimeout
      evidence.concurrentError = await window.__runP1AnalysisProbe().then(() => '', e => e.message)
      evidence.failure = await Promise.race([
        timed,
        new Promise((_, reject) => { watchdog = nativeSetTimeout(() => reject(new Error('Timeout injection did not complete')), 10_000) }),
      ])
      return evidence
    } finally {
      window.clearTimeout(watchdog)
      window.clearTimeout(acceleratedTimer)
      channel.close()
      window.setTimeout = nativeSetTimeout
      window.Worker = NativeWorker
      if (worker && !evidence.terminated) worker.terminate()
    }
  })
  await page.unroute(programRoute, injectProgram)
  if (injected !== 1 || timeout.constructed !== 1 || timeout.posted !== 1 || timeout.messages !== 0 || timeout.enteredCallMain !== 1 || timeout.enteredAtTermination !== 1 || timeout.accelerated !== 1 || timeout.terminated !== 1 || timeout.failure !== 'Isolated DegenGeom timed out; its disposable worker was terminated' || !timeout.concurrentError.includes('already running')) throw new Error(`P1 timeout was not handled: ${JSON.stringify({ injected, ...timeout })}`)
  const afterTimeout = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  if (JSON.stringify(before) !== JSON.stringify(afterTimeout)) throw new Error('Page model changed after worker timeout')
  // A full subsequent run proves the guard was released and real workers recover.
  const { result, concurrentError } = await page.evaluate(async () => {
    const first = window.__runP1AnalysisProbe()
    const concurrentError = await window.__runP1AnalysisProbe().then(() => '', e => e.message)
    return { result: await first, concurrentError }
  })
  if (!concurrentError.includes('already running')) throw new Error('Concurrent isolated diagnostic was not rejected')
  const after = await page.evaluate(() => window.__webvspEngine.request('GET', '/model'))
  if (!result || result.pageModelUsed !== false || result.isolation !== 'disposable-fixed-model' || result.reports?.length !== 2) throw new Error(`Invalid P1 result: ${JSON.stringify(result)}`)
  for (const [i, model] of ['WING', 'PROP'].entries()) {
    const r = result.reports[i]
    if (r.model !== model || r.DegenGeom.objects < 1 || r.SurfacePatches.patches < 1) throw new Error(`Invalid ${model} analysis summary: ${JSON.stringify(r)}`)
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Page model snapshot changed during isolated analysis')
  if (external.length || errors.length) throw new Error(`Unexpected requests/errors: ${JSON.stringify({ external, errors })}`)
  console.log(JSON.stringify({ ...result, faultInjection: fault, timeoutInjection: timeout, guardRecovered: true, pageModelUnchanged: true, externalRequests: external.length }))
} finally { await browser.close() }
