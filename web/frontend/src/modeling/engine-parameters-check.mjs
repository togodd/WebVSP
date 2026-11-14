// Requires vite.modeling-test.config.ts backed by a WASM build from the same checkout.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
let progress = 'starting browser'
const deadline = setTimeout(() => { console.error(`Parameter check exceeded the 300s global deadline (last step: ${progress})`); void browser.close() }, 300000)
const stage = value => { progress = value; console.log(`[parameter-check] ${value}`) }
try {
  const page = await browser.newPage()
  // CDP can garbage-collect the promise returned by an awaited evaluate while WASM
  // is busy. Start exactly once, retain the task in the page, and poll only its
  // synchronous status. In particular, never retry a potentially mutating call.
  const evaluate = page.evaluate.bind(page)
  let evaluationId = 0
  page.evaluate = async (fn, arg) => {
    const id = ++evaluationId
    await evaluate(({ id, source, arg }) => {
      const tasks = window.__parameterCheckTasks ??= new Map()
      const task = { state: 'pending' }
      tasks.set(id, task)
      try {
        Promise.resolve((0, eval)(`(${source})`)(arg)).then(
          value => Object.assign(task, { state: 'fulfilled', value }),
          error => Object.assign(task, { state: 'rejected', error: {
            name: error?.name, message: error?.message ?? String(error), stack: error?.stack,
            code: error?.code, outcome: error?.outcome, actual: error?.actual,
          } }),
        )
      } catch (error) {
        Object.assign(task, { state: 'rejected', error: { name: error?.name, message: error?.message ?? String(error), stack: error?.stack } })
      }
    }, { id, source: fn.toString(), arg })
    try {
      const completed = await page.waitForFunction(id => { const task = window.__parameterCheckTasks?.get(id); return task && task.state !== 'pending' }, id, { timeout: 30000, polling: 10 })
      await completed.dispose()
      const result = await evaluate(id => window.__parameterCheckTasks.get(id), id)
      if (result.state === 'rejected') {
        const error = new Error(result.error.message)
        Object.assign(error, result.error)
        throw error
      }
      return result.value
    } finally {
      await evaluate(id => window.__parameterCheckTasks?.delete(id), id).catch(() => {})
    }
  }
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const request = (method, path, body) => page.evaluate(({ method, path, body }) => window.__webvspEngine.request(method, path, body), { method, path, body })
  await page.evaluate(async () => { const m = await import('/src/modeling/index.ts'); window.testModeling = m.createBrowserModelingService() })
  stage('create geometry')
  const wing = (await request('POST', '/geoms', { type: 'WING' })).id
  const pod = (await request('POST', '/geoms', { type: 'POD' })).id
  const clone = (await request('POST', '/geoms', { type: 'CLONE' })).id
  const fuselage = (await request('POST', '/geoms', { type: 'FUSELAGE' })).id
  const surfaces = await request('GET', `/geoms/${wing}/xsecs`)
  const ids = await request('GET', `/geoms/${wing}/parms`)
  const token = await page.evaluate(async () => (await window.testModeling.model.getInfo()).identity)
  const facadeIds = await page.evaluate(({ wing, token }) => window.testModeling.parameter.listGeometryParameterIds(wing, token), { wing, token })
  assert.deepEqual(facadeIds, ids)
  const capabilities = (await page.evaluate(() => window.testModeling.capabilities())).features
  assert.equal(capabilities.find(x => x.name === 'parameter.read').status, 'supported')
  assert.equal(capabilities.find(x => x.name === 'parameter.write').status, 'supported')
  assert.ok(surfaces.length && surfaces[0].xsecs.length && ids.length)
  const parameter = await request('GET', `/geoms/${wing}/parms/${ids[0]}`)
  assert.equal(parameter.id, ids[0]); assert.equal(typeof parameter.value, 'number')
  const section = surfaces[0].xsecs[0]
  const sectionIds = await request('GET', `/xsecs/${section}/parms`)
  assert.ok(sectionIds.length)
  assert.equal((await request('GET', `/xsecs/${section}/parms/${sectionIds[0]}`)).id, sectionIds[0])
  const lengths = []
  const fuselageParms = await request('GET', `/geoms/${fuselage}/parms`)
  stage(`scan fuselage parameters (0/${fuselageParms.length})`)
  let scanned = 0
  for (const id of fuselageParms) {
    if (++scanned % 50 === 0) stage(`scan fuselage parameters (${scanned}/${fuselageParms.length})`)
    const candidate = await request('GET', `/geoms/${fuselage}/parms/${id}`)
    if (candidate.name === 'Length' && candidate.group === 'Design' && candidate.container === fuselage) lengths.push(candidate)
  }
  assert.equal(lengths.length, 1, 'Expected exactly one top-level fuselage Design/Length parameter')
  const length = lengths[0]
  assert.ok(length.active, 'Expected an active fuselage length parameter')
  assert.deepEqual(await request('GET', `/geoms/${fuselage}/fuselage-length`), length)
  // A POD also has a top-level Design/Length: matching metadata is not a type check.
  stage('check POD parameter metadata')
  const podParms = await request('GET', `/geoms/${pod}/parms`)
  const podMetadata = await Promise.all(podParms.map(id => request('GET', `/geoms/${pod}/parms/${id}`)))
  assert.ok(podMetadata.some(p => p.name === 'Length' && p.group === 'Design' && p.container === pod))
  for (const geom of [pod, wing, clone]) {
    await assert.rejects(() => request('GET', `/geoms/${geom}/fuselage-length`), /not a fuselage/i)
  }
  await assert.rejects(() => request('GET', '/geoms/NOTREAL/fuselage-length'), /not found in the current model/i)
  stage('find tessellation parameter')
  let tess
  for (const id of fuselageParms) {
    const candidate = await request('GET', `/geoms/${fuselage}/parms/${id}`)
    if (candidate.name === 'Tess_W' && candidate.group === 'Shape') { tess = candidate; break }
  }
  assert.ok(tess?.active && tess.value === 17)
  const tessPath = `/geoms/${fuselage}/parms/${tess.id}`
  stage('check parameter writes and errors')
  const quantized = await page.evaluate(async path => {
    try { await window.__webvspEngine.request('PUT', path, {value: 18}); return null }
    catch (error) { return {outcome: error.outcome, actual: error.actual} }
  }, tessPath)
  assert.deepEqual(quantized, {outcome: 'not_written', actual: 17})
  assert.equal((await request('GET', tessPath)).value, 17)
  const path = `/geoms/${fuselage}/parms/${length.id}`
  const input = { owner: 'geometry', ownerId: fuselage, parameterId: length.id, value: 20 }
  const facadeWrite = await page.evaluate(({ input, token }) => window.testModeling.parameter.set(input, token), { input, token })
  assert.deepEqual(facadeWrite, { actual: 20 })
  assert.equal((await request('GET', path)).value, 20)
  const actual = await request('PUT', path, { value: 21 })
  assert.equal(actual.actual, 21)
  assert.equal((await request('GET', path)).value, 21)
  // Restore the value expected by the later error and race checks.
  const restored = await request('PUT', path, { value: 20 })
  assert.equal(restored.actual, 20)
  assert.equal((await request('GET', path)).value, 20)
  const failure = await page.evaluate(async ({ path, value }) => {
    try { await window.__webvspEngine.request('PUT', path, { value }); return null }
    catch (error) { return {outcome: error.outcome, actual: error.actual} }
  }, { path, value: length.upperLimit + 1 })
  assert.deepEqual(failure, {outcome: 'not_written', actual: 20})
  assert.equal((await request('GET', path)).value, 20)
  stage('check write cancellation race')
  const race = await page.evaluate(async ({ input, path }) => {
    const { createParameterWriteService } = await import('/src/modeling/index.ts')
    const controller = new AbortController()
    let dispatched = false
    let finish
    const done = new Promise(resolve => { finish = resolve })
    const service = createParameterWriteService({
      set: async (_owner, _ownerId, _parameterId, value) => {
        dispatched = true
        try { return await window.__webvspEngine.request('PUT', path, { value }) }
        finally { finish() }
      },
    }, controller.signal)
    const pending = service.set({ ...input, value: 21 })
    controller.abort()
    let outcome
    try { await pending; outcome = null } catch (error) { outcome = error.code }
    await done
    let closed
    try { await service.set(input); closed = null } catch (error) { closed = error.code }
    return { dispatched, outcome, closed }
  }, { input, path })
  assert.deepEqual(race, { dispatched: true, outcome: 'OUTCOME_UNKNOWN', closed: 'SESSION_CLOSED' })
  // The dispatched engine request still runs; close cannot cancel it.
  assert.equal((await request('GET', path)).value, 21)
  stage('check stale references')
  await page.evaluate(() => window.testModeling.close())
  await assert.rejects(() => request('GET', `/geoms/${fuselage}/parms/${ids[0]}`))
  await assert.rejects(() => request('GET', '/xsecs/NOTREAL/parms'))
  await assert.rejects(() => request('GET', '/geoms/NOTREAL/parms'))
  await request('POST', '/geoms/delete', { ids: [wing, fuselage] })
  await assert.rejects(() => request('GET', `/xsecs/${section}/parms`))
  await assert.rejects(() => request('GET', `/geoms/${fuselage}/fuselage-length`), /not found in the current model/i)
  assert.deepEqual(errors, [])
  console.log('PASS: geometry and cross-section parameter ownership, metadata and stale references')
} finally {
  clearTimeout(deadline)
  await browser.close()
}
