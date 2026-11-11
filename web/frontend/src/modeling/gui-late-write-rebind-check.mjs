// GUI regression: a same-path Save As is cancelled while the old write-back is in flight.
// Run: WEBVSP_URL=http://127.0.0.1:5179/ CHROMIUM_PATH=/path/to/chrome \
//      node src/modeling/gui-late-write-rebind-check.mjs
// Requires web/frontend's installed playwright-core and an existing running WebVSP GUI.
// All picker handles and file contents are in memory; no user files are opened or written.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const url = process.env.WEBVSP_URL || 'http://127.0.0.1:5179/'
const executablePath = process.env.CHROMIUM_PATH || chromium.executablePath()
const timeout = Number(process.env.WEBVSP_TIMEOUT_MS || 30000)
assert(Number.isFinite(timeout) && timeout > 0, 'WEBVSP_TIMEOUT_MS must be positive')

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const pageErrors = []
const downloads = []
const consoleErrors = []
let page
try {
  page = await browser.newPage({ acceptDownloads: false })
  page.on('pageerror', error => pageErrors.push(error.stack || error.message))
  page.on('download', download => downloads.push(download.suggestedFilename()))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.addInitScript(() => {
    const events = []
    const queue = []
    let releaseOldClose
    window.race = {
      events,
      queue,
      handles: {},
      releaseOld() {
        if (!releaseOldClose) throw new Error('old close has not started')
        releaseOldClose()
      },
      makeHandle(id, blockClose = false) {
        return {
          name: 'race.vsp3', kind: 'file',
          async queryPermission() { events.push(`${id}:permission`); return 'granted' },
          async createWritable() {
            events.push(`${id}:create`)
            return {
              async write(data) { events.push(`${id}:write:${data.byteLength}`) },
              async close() {
                events.push(`${id}:close-start`)
                if (blockClose) await new Promise(resolve => { releaseOldClose = resolve })
                events.push(`${id}:close-done`)
              },
            }
          },
        }
      },
    }
    window.showSaveFilePicker = async () => {
      const entry = queue.shift()
      if (!entry) throw new Error('unexpected save picker')
      events.push(`${entry.id}:picked`)
      return entry.handle
    }
    window.showOpenFilePicker = async () => {
      events.push('bad:picker')
      return [{ name: 'race.vsp3', async getFile() {
        events.push('bad:getFile-rejected')
        throw new Error('intentional fake open failure')
      } }]
    }
  })

  async function menu(label) {
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await page.getByText(label, { exact: true }).click()
  }
  async function waitForEvent(event, count = 1) {
    await page.waitForFunction(({ event, count }) =>
      window.race.events.filter(item => item === event).length >= count,
    { event, count }, { timeout })
  }
  async function queueHandle(id, blockClose = false) {
    await page.evaluate(({ id, blockClose }) => {
      const handle = window.race.makeHandle(id, blockClose)
      window.race.handles[id] = handle
      window.race.queue.push({ id, handle })
    }, { id, blockClose })
  }

  await page.goto(url, { timeout })
  await page.getByRole('button', { name: 'File', exact: true }).waitFor({ timeout: Math.max(timeout, 60000) })
  await queueHandle('old', true)
  await menu('Save As...')
  await waitForEvent('old:close-start')
  await queueHandle('new')
  await menu('Save As...')
  await waitForEvent('new:picked')
  await page.waitForFunction(() => window.__webvspEngine.testFiles.state('/home/web_user/race.vsp3')?.writing, null, { timeout })
  // A subsequent GUI operation proves the rejected native dialog was answered.
  await page.getByRole('status').filter({ hasText: 'Save As was rejected' }).waitFor({ timeout })
  assert.equal(await page.evaluate(() => window.__webvspEngine.testFiles.state('/home/web_user/race.vsp3')?.handle === window.race.handles.old), true, 'old binding must survive cancellation')
  assert.deepEqual((await page.evaluate(() => window.race.events)).filter(e => e.startsWith('new:')), ['new:picked'], 'rejected handle must not be written')
  await menu('Open...')
  await waitForEvent('bad:getFile-rejected')
  await page.evaluate(() => window.race.releaseOld())
  await waitForEvent('old:close-done')
  await page.waitForFunction(() => !window.__webvspEngine.testFiles.state('/home/web_user/race.vsp3')?.writing, null, { timeout })
  await queueHandle('retry')
  await menu('Save As...')
  await waitForEvent('retry:close-done')
  assert.equal(await page.evaluate(() => window.__webvspEngine.testFiles.state('/home/web_user/race.vsp3')?.handle === window.race.handles.retry), true, 'retry must bind the new handle')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await menu('Save...')
  await waitForEvent('retry:close-done', 2)
  await page.waitForTimeout(1500)

  const events = await page.evaluate(() => window.race.events)
  console.log('Observed fake-handle events:', JSON.stringify(events, null, 2))
  const normalized = events.map(event => {
    const match = /^(old|new|retry):write:(\d+)$/.exec(event)
    if (!match) return event
    assert(Number(match[2]) > 0, `empty write: ${event}`)
    return `${match[1]}:write`
  })
  assert.deepEqual(normalized, [
    'old:picked', 'old:permission', 'old:create', 'old:write', 'old:close-start',
    'new:picked', 'bad:picker', 'bad:getFile-rejected', 'old:close-done',
    'retry:picked', 'retry:permission', 'retry:create', 'retry:write', 'retry:close-start', 'retry:close-done',
    'retry:permission', 'retry:create', 'retry:write', 'retry:close-start', 'retry:close-done',
  ], 'unexpected fake-handle event trace')
  assert.deepEqual(downloads, [], 'unexpected browser download')
  assert.deepEqual(pageErrors, [], 'uncaught page errors')
  assert.deepEqual(consoleErrors, [], 'unexpected browser console errors')
  console.log('PASS: busy same-path Save As cancelled, old binding preserved, retry succeeded after close.')
} catch (error) {
  if (pageErrors.length) console.error('Uncaught page errors:', pageErrors)
  if (downloads.length) console.error('Unexpected downloads:', downloads)
  if (page) {
    try { console.error('Events at failure:', await page.evaluate(() => window.race?.events)) } catch { /* page already closed */ }
  }
  throw error
} finally {
  await browser.close()
}
