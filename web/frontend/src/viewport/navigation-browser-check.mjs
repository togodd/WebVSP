// Real Chromium + local WASM: WEBVSP_TEST_CHROMIUM=/path/to/chrome node src/viewport/navigation-browser-check.mjs
// Starts and stops its own isolated Vite server; requires a trusted matching WASM at :8090.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM to a Chromium executable')
const probe = createServer()
await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const base = `http://127.0.0.1:${port}`
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.modeling-test.config.ts', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(), env: { ...process.env, WEBVSP_TEST_WASM_ORIGIN: 'http://127.0.0.1:8090' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
vite.stdout.on('data', data => { output += data })
vite.stderr.on('data', data => { output += data })
let browser
try {
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${output}`)
    try { if ((await fetch(base)).ok) break } catch {}
    if (i === 99) throw new Error(`Vite did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  const id = await page.evaluate(async () => {
    const e = window.__webvspEngine
    const model = await e.testCall('model', '', '', 0)
    if (model.geoms.length) throw Error('Expected empty isolated model')
    return (await e.testCallGuarded('addGeom', 'FUSELAGE', '', 0, model.modelEpoch)).id
  })
  await page.waitForFunction(async () => (await window.__webvspEngine.request('GET', '/model')).geoms.length === 1)
  await page.waitForTimeout(2500)
  const canvas = page.locator('canvas').first()
  let rect = await canvas.boundingBox()
  assert(rect)
  // React Three Fiber's root store is observable without changing application code.
  const state = () => page.evaluate(async () => {
    const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js')
    const root = [..._roots.values()][0]
    const { camera, controls, scene } = root.store.getState()
    const point = camera.position.clone().set(0, 0, 0).project(camera).toArray()
    const objects = []
    scene.traverse(o => { if (o.type.includes('TransformControls')) objects.push({ type: o.type, name: o.name }) })
    return { position: camera.position.toArray(), target: controls.target.toArray(), direction: camera.getWorldDirection(camera.position.clone()).toArray(), zoom: camera.zoom, type: camera.type, point, objects }
  })
  const origin = () => page.evaluate(id => window.__webvspEngine.request('GET', `/geoms/${id}/origin`), id)
  const drag = async (button, modifiers, dx, dy) => {
    const x = rect.x + rect.width * 0.35, y = rect.y + rect.height * 0.35
    await page.mouse.move(x, y)
    for (const key of modifiers) await page.keyboard.down(key)
    await page.mouse.down({ button })
    await page.mouse.move(x + dx, y + dy, { steps: 8 })
    await page.mouse.up({ button })
    for (const key of modifiers.reverse()) await page.keyboard.up(key)
    await page.waitForTimeout(150)
  }
  const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]))
  const beforeOrigin = await origin()
  const gestures = async projection => {
  for (const [name, button, mods, dx, dy, kind] of [
    ['right pan', 'right', [], 80, 35, 'pan'],
    ['Ctrl+right pan', 'right', ['Control'], 80, 35, 'pan'],
    ['Alt+left pan', 'left', ['Alt'], 80, 35, 'pan'],
    ['Ctrl+left zoom', 'left', ['Control'], 0, 80, 'zoom'],
    ['left orbit', 'left', [], 80, 35, 'orbit'],
  ]) {
    const a = await state()
    assert.equal(a.type, projection)
    await drag(button, mods, dx, dy)
    const b = await state()
    console.log(name, JSON.stringify({ before: a, after: b }))
    if (kind === 'pan') {
      assert(dist(a.target, b.target) > 0.01, `${name}: target did not move`)
      assert(b.point[0] > a.point[0] && b.point[1] < a.point[1], `${name}: world origin must follow the drag right and down`)
      assert(dist(a.direction, b.direction) < 1e-4, `${name}: direction changed`)
      assert(dist(a.position.map((v, i) => v - a.target[i]), b.position.map((v, i) => v - b.target[i])) < 1e-4, `${name}: camera/target offset changed`)
    } else if (kind === 'zoom') {
      assert(dist(b.position, b.target) > dist(a.position, a.target) || b.zoom < a.zoom, `${name}: downward drag must zoom out`)
      assert(dist(a.direction, b.direction) < 1e-4, `${name}: rotated`)
    } else assert(dist(a.direction, b.direction) > 0.01, `${name}: direction did not change`)
    assert.deepEqual(await origin(), beforeOrigin, `${name}: model origin changed`)
  }
  }
  await gestures('PerspectiveCamera')
  await page.keyboard.press('5')
  await page.waitForFunction(async () => {
    const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js')
    return [..._roots.values()][0].store.getState().camera.type === 'OrthographicCamera'
  })
  await page.waitForTimeout(500)
  await gestures('OrthographicCamera')
  await page.keyboard.press('5')
  await page.keyboard.press('f')
  await page.waitForTimeout(1200)
  // Fit centers the fuselage rather than its origin; zoom out so the origin/gizmo is on canvas.
  await drag('left', ['Control'], 0, 100)
  await page.evaluate(id => window.__webvspEngine.request('POST', '/pick', { id, toggle: false }), id)
  await page.waitForFunction(async id => (await window.__webvspEngine.request('GET', '/model')).active.includes(id), id)
  await page.waitForTimeout(1000)
  // Selecting a geom can open a side panel and resize the canvas.
  rect = await canvas.boundingBox()
  assert(rect)
  const selected = await state()
  assert(selected.objects.some(o => o.type === 'TransformControlsGizmo'), 'selected geom must have a move gizmo')
  // Drag directly at its projected origin, rather than at an arbitrary empty area.
  const gizmoX = rect.x + (selected.point[0] + 1) * rect.width / 2
  const gizmoY = rect.y + (1 - selected.point[1]) * rect.height / 2
  assert(gizmoX > rect.x && gizmoX < rect.x + rect.width && gizmoY > rect.y && gizmoY < rect.y + rect.height, 'projected gizmo origin must be inside canvas')
  const selectedOrigin = await origin()
  const cameraBefore = await state()
  await page.mouse.move(gizmoX, gizmoY)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(gizmoX + 45, gizmoY + 25, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  const cameraAfter = await state()
  console.log('gizmo right drag', JSON.stringify({ rect, gizmoX, gizmoY, selected, cameraBefore, cameraAfter }))
  assert(dist(cameraBefore.target, cameraAfter.target) > 0.01, 'right drag over selected gizmo must pan')
  assert.deepEqual(await origin(), selectedOrigin, 'right drag over gizmo changed geom origin')
  for (const [key, mode] of [['g', 'move'], ['r', 'rotate']]) {
    await page.keyboard.press(key)
    await page.waitForFunction(async mode => (await import('/src/viewport/transform.tsx')).useTransform.getState().mode === mode, mode)
    await page.keyboard.press('x')
    await page.keyboard.press('2')
    const during = await page.evaluate(async () => {
      const { useTransform, usePreview } = await import('/src/viewport/transform.tsx')
      return { transform: useTransform.getState(), preview: usePreview.getState() }
    })
    assert.equal(during.transform.typed, '2', `${key}: expected nonzero typed transform`)
    assert(during.preview.ids.includes(id), `${key}: transform did not create preview`)
    await page.keyboard.press('Escape')
    await page.waitForFunction(async () => (await import('/src/viewport/transform.tsx')).useTransform.getState().mode === null)
    const cancelled = await page.evaluate(async () => (await import('/src/viewport/transform.tsx')).usePreview.getState())
    assert.equal(cancelled.ids.length, 0, `${key}: cancel left a preview`)
    assert.deepEqual(await origin(), beforeOrigin, `${key} cancel changed model origin`)
  }
  // Find a real single-axis translate picker hit by raycasting, after G unmounted and remounted it.
  const findAxis = () => page.evaluate(async ({ canvasWidth, canvasHeight }) => {
    const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js')
    const THREE = await import('/node_modules/.vite/deps/three.js')
    const { scene, camera } = [..._roots.values()][0].store.getState()
    let gizmo
    scene.traverse(o => { if (o.type === 'TransformControlsGizmo') gizmo = o })
    if (!gizmo) throw Error('gizmo did not remount')
    const picker = gizmo.picker.translate
    scene.updateMatrixWorld(true)
    const ray = new THREE.Raycaster()
    const p = new THREE.Vector3(0, 0, 0).project(camera)
    // Sample the pickable projected area; mirror TransformControls' own intersection filter.
    for (let y = -90; y <= 90; y += 3) for (let x = -90; x <= 90; x += 3) {
      const ndc = new THREE.Vector2(p.x + x * 2 / canvasWidth, p.y + y * 2 / canvasHeight)
      ray.setFromCamera(ndc, camera)
      const hit = ray.intersectObject(picker, true).find(h => h.object.visible)
      if (hit && ['X', 'Y', 'Z'].includes(hit.object.name)) return { ndc: ndc.toArray(), axis: hit.object.name }
    }
    throw Error('no single-axis gizmo picker hit found')
  }, { canvasWidth: rect.width, canvasHeight: rect.height })
  const axisCoordinates = axisHit => ({
    x: rect.x + (axisHit.ndc[0] + 1) * rect.width / 2,
    y: rect.y + (1 - axisHit.ndc[1]) * rect.height / 2,
  })
  let axisHit = await findAxis()
  let { x: axisX, y: axisY } = axisCoordinates(axisHit)
  assert(axisX > rect.x && axisX < rect.x + rect.width && axisY > rect.y && axisY < rect.y + rect.height, 'axis hit must be inside canvas')
  await page.mouse.move(axisX, axisY)
  const axisBefore = await state()
  await page.keyboard.down('Alt')
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(axisX + 55, axisY + 30, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  await page.keyboard.up('Alt')
  await page.waitForTimeout(300)
  const axisAfter = await state()
  assert(dist(axisBefore.target, axisAfter.target) > 0.01, `Alt drag on ${axisHit.axis} picker did not pan`)
  assert.deepEqual(await origin(), beforeOrigin, `Alt drag on ${axisHit.axis} picker moved model`)
  const preview = await page.evaluate(async () => (await import('/src/viewport/transform.tsx')).usePreview.getState())
  assert.equal(preview.ids.length, 0, 'Alt drag on axis left a transform preview')
  console.log('PASS: raycast axis after G/R cancel:', axisHit.axis)

  // A plain left drag must still manipulate the real gizmo and commit to the engine.
  axisHit = await findAxis()
  ;({ x: axisX, y: axisY } = axisCoordinates(axisHit))
  await page.mouse.move(axisX, axisY)
  const hoveredAxis = await page.evaluate(async () => {
    const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js')
    let control
    ;[..._roots.values()][0].store.getState().scene.traverse(o => { if (o.type === 'TransformControlsGizmo') control = o.parent })
    const r = control?.domElement.getBoundingClientRect()
    return { axis: control?.axis, element: r && { x: r.x, y: r.y, width: r.width, height: r.height } }
  })
  assert.equal(hoveredAxis.axis, axisHit.axis, `raycast axis and actual TransformControls hover differ: ${JSON.stringify({ axisHit, axisX, axisY, hoveredAxis })}`)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(axisX + 70, axisY + 45, { steps: 12 })
  await page.mouse.up({ button: 'left' })
  await page.waitForFunction(async ({ id, before }) => {
    const p = await window.__webvspEngine.request('GET', `/geoms/${id}/origin`)
    return Math.hypot(...p.map((v, i) => v - before[i])) > 0.01
  }, { id, before: beforeOrigin }, { timeout: 10000 })
  const moved = await origin()
  const delta = moved.map((v, i) => v - beforeOrigin[i])
  const index = ['X', 'Y', 'Z'].indexOf(axisHit.axis)
  assert(Math.abs(delta[index]) > 0.01, `${axisHit.axis} drag did not move along the selected axis: ${delta}`)
  assert(delta.every((v, i) => i === index || Math.abs(v) < 1e-5), `${axisHit.axis} drag moved off axis: ${delta}`)
  await page.evaluate(({ id, delta }) => window.__webvspEngine.request('POST', '/geoms/move', { ids: [id], delta: delta.map(v => -v) }), { id, delta })
  await page.waitForFunction(async ({ id, before }) => {
    const p = await window.__webvspEngine.request('GET', `/geoms/${id}/origin`)
    return Math.hypot(...p.map((v, i) => v - before[i])) < 1e-5
  }, { id, before: beforeOrigin })
  console.log('PASS: actual single-axis drag and restored origin:', axisHit.axis, delta)

  // Projection replacement must leave the remounted gizmo protected as well.
  await page.keyboard.press('5')
  await page.waitForFunction(async () => {
    const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js')
    return [..._roots.values()][0].store.getState().camera.type === 'OrthographicCamera'
  })
  await page.waitForTimeout(700)
  axisHit = await findAxis()
  ;({ x: axisX, y: axisY } = axisCoordinates(axisHit))
  assert(axisX > rect.x && axisX < rect.x + rect.width && axisY > rect.y && axisY < rect.y + rect.height, 'orthographic axis hit must be inside canvas')
  await page.mouse.move(axisX, axisY)
  const switchedBefore = await state()
  const previewBeforeSwitchDrag = await page.evaluate(async () => (await import('/src/viewport/transform.tsx')).usePreview.getState())
  await page.keyboard.down('Alt')
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(axisX + 55, axisY + 30, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  await page.keyboard.up('Alt')
  await page.waitForTimeout(300)
  assert(dist(switchedBefore.target, (await state()).target) > 0.01, `orthographic Alt drag on ${axisHit.axis} did not pan`)
  assert(dist(await origin(), beforeOrigin) < 1e-5, 'orthographic Alt axis drag moved model')
  assert.deepEqual(await page.evaluate(async () => (await import('/src/viewport/transform.tsx')).usePreview.getState()), previewBeforeSwitchDrag, 'orthographic Alt drag changed transform preview')
  console.log('PASS: Alt drag on axis after projection switch:', axisHit.axis)
  assert.deepEqual(errors, [])
  console.log('PASS: both projection gestures, model-origin invariance, G/R cancellation')
} finally {
  if (browser) await browser.close()
  vite.kill('SIGTERM')
  await new Promise(resolve => vite.exitCode !== null || vite.signalCode !== null ? resolve() : vite.once('exit', resolve))
}
