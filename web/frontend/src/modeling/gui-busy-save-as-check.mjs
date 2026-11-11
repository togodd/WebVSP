// Isolated regression: real dialog/watcher code, fake filesystem and handles only.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const executablePath = process.env.WEBVSP_TEST_CHROMIUM
if (!executablePath) throw new Error('Set WEBVSP_TEST_CHROMIUM')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  await page.goto(process.env.WEBVSP_TEST_PAGE ?? 'http://127.0.0.1:5179/')
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  const result = await page.evaluate(async () => {
    const api = window.__webvspEngine.testFiles
    const { useFileNotice } = await import('/src/api/fileNotice.ts')
    const notices = []
    const unsubscribe = useFileNotice.subscribe(state => { if (state.notice) notices.push(state.notice) })
    api.clear()
    const files = new Map(), answers = [], delivered = [], mkdirs = []
    let time = 0, release
    const barrier = new Promise(resolve => { release = resolve })
    const old = {
      name: 'old.vsp3', getFile: async () => new File(['original'], 'old.vsp3'),
      queryPermission: async () => 'granted',
      createWritable: async () => {
        await barrier
        return { write: async bytes => delivered.push(new TextDecoder().decode(bytes)), close: async () => delivered.push('closed') }
      },
    }
    let chosen = { name: 'old.vsp3' }
    window.showOpenFilePicker = async () => [old]
    window.showSaveFilePicker = async () => chosen
    const vsp = {
      mirrorEvent: s => answers.push(JSON.parse(s)),
      FS: {
        mkdirTree: path => mkdirs.push(path),
        writeFile: (path, data) => files.set(path, { data: new Uint8Array(data), time: ++time }),
        readFile: path => files.get(path).data,
        analyzePath: path => ({ exists: files.has(path) }),
        stat: path => ({ mtime: new Date(files.get(path).time), size: files.get(path).data.length }),
      },
    }
    const path = '/home/web_user/old.vsp3'
    await api.answer(vsp, { seq: 1, mode: 0, filter: '*.vsp3' })
    const binding = api.state(path)
    vsp.FS.writeFile(path, new TextEncoder().encode('unsaved'))
    api.watch(vsp)
    mkdirs.length = 0
    await api.answer(vsp, { seq: 2, mode: 1, filter: '*.vsp3' })
    const pending = { answer: answers.at(-1), same: api.state(path) === binding, flag: binding.pending, mkdirs: [...mkdirs] }
    api.watch(vsp)
    await api.answer(vsp, { seq: 3, mode: 1, filter: '*.vsp3' })
    const writing = { answer: answers.at(-1), same: api.state(path) === binding, flag: binding.writing, mkdirs: [...mkdirs] }
    chosen = { name: 'Old.vsp3' }
    await api.answer(vsp, { seq: 4, mode: 1, filter: '*.vsp3' })
    const other = { answer: answers.at(-1), oldSame: api.state(path) === binding }
    release()
    while (binding.writing) await new Promise(resolve => setTimeout(resolve, 0))
    chosen = { name: 'old.vsp3' }
    await api.answer(vsp, { seq: 5, mode: 1, filter: '*.vsp3' })
    const success = { answer: answers.at(-1), rebound: api.state(path) !== binding, handle: api.state(path).handle === chosen }
    unsubscribe()
    return { pending, writing, other, delivered, success, notices }
  })
  for (const conflict of [result.pending, result.writing]) {
    assert.equal(conflict.answer.result, 0)
    assert.equal(conflict.answer.path, '')
    assert.equal(conflict.same, true)
    assert.equal(conflict.flag, true)
    assert.deepEqual(conflict.mkdirs, [])
  }
  assert.equal(result.other.answer.path, '/home/web_user/Old.vsp3')
  assert.equal(result.other.oldSame, true)
  assert.deepEqual(result.delivered, ['unsaved', 'closed'])
  assert.equal(result.success.answer.path, '/home/web_user/old.vsp3')
  assert.equal(result.success.rebound, true)
  assert.equal(result.success.handle, true)
  assert.equal(result.notices.length, 2)
  for (const notice of result.notices) {
    assert.deepEqual({ kind: notice.kind, operation: notice.operation, name: notice.name }, { kind: 'busy', operation: 'save', name: 'old.vsp3' })
    assert.equal(typeof notice.id, 'number')
  }
  assert.ok(result.notices[1].id > result.notices[0].id)
  console.log('PASS: Save As rejects pending/writing exact paths, preserves delivery, allows other and settled paths')
} finally { await browser.close() }
