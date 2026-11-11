// Isolated browser regression: fake picker/FS, real DEV dialog path and mounted GUI.
// No host files or real engine filesystem are modified.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM ?? '/home/togo/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ serviceWorkers: 'block', locale: 'en-US' })
  page.on('pageerror', e => console.error('PAGE ERROR:', e))
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  await page.evaluate(() => {
    const api = window.__webvspEngine.testFiles
    if (!api) throw new Error('DEV testFiles unavailable')
    api.clear()
    const data = new Map(), answers = [], writes = []
    window.showOpenFilePicker = async () => [{ getFile: async () => new File(['abcdef'], 'partial.vsp3') }]
    const vsp = {
      mirrorEvent: s => answers.push(JSON.parse(s)),
      FS: {
        mkdirTree: () => {},
        analyzePath: p => ({ exists: data.has(p) }),
        stat: p => ({ mtime: new Date(1), size: data.get(p).length }),
        writeFile: (p, bytes) => { writes.push(p); data.set(p, Array.from(bytes.slice(0, 3))); throw Error('injected after partial write') },
      },
    }
    window.__partialTest = { data, answers, writes, fail: seq => api.answer(vsp, { seq, mode: 0, filter: '*.vsp3' }) }
  })
  // An independent focused control proves the notification itself does not move focus.
  await page.evaluate(() => { const b = document.createElement('button'); b.id = 'focus-sentinel'; b.textContent = 'sentinel'; document.body.append(b); b.focus() })
  await page.evaluate(() => window.__partialTest.fail(101))
  const alert = page.getByRole('alert').filter({ hasText: 'Import may have only partially completed' })
  await alert.waitFor()
  assert.deepEqual(await page.evaluate(() => ({ bytes: window.__partialTest.data.get('/home/web_user/partial.vsp3'), writes: window.__partialTest.writes, answers: window.__partialTest.answers, focus: document.activeElement.id })), {
    bytes: [97, 98, 99], writes: ['/home/web_user/partial.vsp3'], answers: [{ op: 'dialog', seq: 101, result: 0, path: '' }], focus: 'focus-sentinel',
  })
  await page.evaluate(async () => { const { notifyFileError } = await import('/src/api/fileNotice.ts'); notifyFileError({ kind: 'error', operation: 'open' }) })
  await page.getByRole('status').getByText('Open failed. Check the file and try again.').waitFor()
  assert.equal(await alert.count(), 1)
  await page.waitForTimeout(10500) // Longer than the ordinary notice's 10-second lifetime.
  assert.equal(await alert.count(), 1)
  assert.equal(await page.getByRole('status').getByText('Open failed. Check the file and try again.').count(), 0)
  const dismiss = alert.getByRole('button', { name: 'Dismiss warning' })
  await dismiss.focus()
  await page.keyboard.press('Enter')
  assert.equal(await alert.count(), 0)
  console.log('PASS: partial fake write and one cancelled answer; alert persists >10s, preserves focus, survives ordinary notice, Enter dismisses normally')

  // Drive the real delete prompt through its exported entry point, with a fake selection.
  await page.evaluate(async () => {
    const moduleUrl = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path)
    const { useStore } = await import(moduleUrl('/src/store.ts'))
    const { askDelete } = await import(moduleUrl('/src/mirror/DeleteConfirm.tsx'))
    const state = useStore.getState()
    useStore.setState({ tree: { ...state.tree, active: ['test-id'] }, geomsById: { ...state.geomsById, 'test-id': { name: 'Test geom' } } })
    window.__partialDelete = false
    askDelete(() => { window.__partialDelete = true })
  })
  await page.getByRole('alertdialog').waitFor()
  await page.evaluate(() => window.__partialTest.fail(102))
  await alert.waitFor()
  await alert.getByRole('button').focus()
  await page.keyboard.press('Enter')
  assert.equal(await alert.count(), 1)
  assert.equal(await page.evaluate(() => window.__partialDelete), false)
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) await alert.getByRole('button').dispatchEvent(type, { button: 0, bubbles: true, cancelable: true })
  assert.equal(await alert.count(), 1)
  assert.equal(await page.evaluate(() => window.__partialDelete), false)
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  await alert.getByRole('button').click()
  assert.equal(await alert.count(), 0)
  console.log('PASS: modal blocks warning keyboard and click without deleting; ordinary click dismisses')

  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === '/src/viewport/transform.tsx')
    const { useTransform } = await import(url)
    window.__partialTransform = useTransform
    useTransform.setState({ mode: 'move', ids: [], typed: '', mouseMove: [0, 0, 0] })
    await window.__partialTest.fail(103)
  })
  await alert.waitFor()
  await alert.getByRole('button').focus()
  await page.keyboard.press('Enter')
  assert.equal(await alert.count(), 0)
  assert.equal(await page.evaluate(() => window.__partialTransform.getState().mode), 'move')
  await page.evaluate(() => window.__partialTest.fail(104))
  await alert.getByRole('button').click()
  assert.equal(await alert.count(), 0)
  assert.equal(await page.evaluate(() => window.__partialTransform.getState().mode), 'move')
  console.log('PASS: warning Enter and click dismiss without applying transform')
} finally { await browser.close() }
