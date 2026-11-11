// Controlled browser regression for pending/writing path collisions. Fake handles and
// FS avoid touching host files; the real file-dialog and watcher code runs in the page.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const api = window.__webvspEngine.testFiles
    api.clear()
    const files = new Map(), writes = [], answers = []
    let time = 0, release
    const barrier = new Promise(resolve => { release = resolve })
    const old = {
      name: 'old.vsp3', getFile: async () => new File(['original'], 'old.vsp3'),
      queryPermission: async () => 'granted',
      createWritable: async () => {
        await barrier
        return { write: async () => {}, close: async () => {} }
      },
    }
    const main = { name: 'main.vsp3', getFile: async () => new File(['main'], 'main.vsp3'), queryPermission: async () => 'granted' }
    const secondary = { name: 'old.vsp3', getFile: async () => new File(['replacement'], 'old.vsp3') }
    let selection = [old]
    window.showOpenFilePicker = async () => selection
    const vsp = {
      mirrorEvent: s => answers.push(JSON.parse(s)),
      FS: {
        mkdirTree: () => {},
        writeFile: (path, data) => { writes.push(path); files.set(path, { data: new Uint8Array(data), time: ++time }) },
        readFile: path => files.get(path).data,
        analyzePath: path => ({ exists: files.has(path) }),
        stat: path => ({ mtime: new Date(files.get(path).time), size: files.get(path).data.length }),
      },
    }
    const dialog = seq => ({ seq, mode: 0, filter: '*.vsp3' })
    const oldPath = '/home/web_user/old.vsp3', mainPath = '/home/web_user/main.vsp3'
    await api.answer(vsp, dialog(1))
    const binding = api.state(oldPath)
    vsp.FS.writeFile(oldPath, new TextEncoder().encode('unsaved'))
    api.watch(vsp)
    const pending = binding.pending
    writes.length = 0
    selection = [main, secondary]
    await api.answer(vsp, dialog(2))
    const rejectedPending = { answer: answers.at(-1), writes: [...writes], sameBinding: api.state(oldPath) === binding, pending: binding.pending, mainExists: files.has(mainPath) }
    api.watch(vsp)
    const writing = binding.writing
    await api.answer(vsp, dialog(3))
    const rejectedWriting = { answer: answers.at(-1), writes: [...writes], sameBinding: api.state(oldPath) === binding, writing: binding.writing, mainExists: files.has(mainPath) }
    release()
    while (binding.writing) await new Promise(resolve => setTimeout(resolve, 0))
    await api.answer(vsp, dialog(4))
    return { pending, writing, rejectedPending, rejectedWriting, success: { answer: answers.at(-1), writes, old: new TextDecoder().decode(files.get(oldPath).data), main: new TextDecoder().decode(files.get(mainPath).data), oldUnlinked: !api.state(oldPath) } }
  })
  assert.equal(result.pending, true)
  assert.equal(result.writing, true)
  for (const rejected of [result.rejectedPending, result.rejectedWriting]) {
    assert.equal(rejected.answer.result, 0)
    assert.equal(rejected.answer.path, '')
    assert.deepEqual(rejected.writes, [])
    assert.equal(rejected.sameBinding, true)
    assert.equal(rejected.mainExists, false)
  }
  assert.equal(result.rejectedPending.pending, true)
  assert.equal(result.rejectedWriting.writing, true)
  assert.equal(result.success.answer.result, 1)
  assert.deepEqual(result.success.writes, ['/home/web_user/main.vsp3', '/home/web_user/old.vsp3'])
  assert.equal(result.success.old, 'replacement')
  assert.equal(result.success.main, 'main')
  assert.equal(result.success.oldUnlinked, true)
  assert.equal(errors.filter(e => e.includes('Import rejected: linked file has pending or in-progress write-back')).length, 2)
  console.log('PASS: controlled pending and writing reject all targets; settled import succeeds')
} finally { await browser.close() }
