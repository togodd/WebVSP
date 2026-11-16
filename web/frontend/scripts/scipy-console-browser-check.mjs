// SciPy-backed original modules in the live Python console.
//   CHROMIUM_PATH=... WEBVSP_URL=http://127.0.0.1:4175/ node scripts/scipy-console-browser-check.mjs
// Checks that SciPy is absent until a command statically imports a module that
// needs it, that the original atmosphere/rotor sources then run unchanged, and
// that a later ordinary command still works in the same session.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4175/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const failures = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = [], external = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  await page.goto(new URL(base).href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120_000 })
  await page.click('[data-testid="console-open"]')
  await page.waitForSelector('[data-testid="console-window"]')

  const run = async (code, timeout = 240_000) => {
    await page.fill('[data-testid="console-input"]', code)
    await page.click('[data-testid="console-run"]')
    await page.waitForFunction(() => !document.querySelector('[data-testid="console-run"]')?.textContent?.includes('…'), null, { timeout })
    const entries = await page.$$eval('[data-testid="console-output"] .py-console-entry', (els) => els.map((el) => ({
      value: el.querySelector('.py-console-value')?.textContent ?? '',
      error: el.querySelector('.py-console-error')?.textContent ?? '',
    })))
    return entries[entries.length - 1]
  }

  // A plain command must not install the ~14 MB SciPy wheel.
  let r = await run('import sys\n"scipy" in sys.modules, __import__("importlib").util.find_spec("scipy") is None')
  if (r.error || r.value.trim() !== '(False, True)') failures.push(`SciPy loaded too early: ${JSON.stringify(r)}`)

  // A dynamic import is not detected; it must fail with guidance, install in the
  // background, and then work on a retry without restarting the session.
  r = await run('import importlib\nimportlib.import_module("utilities.atmosphere")')
  if (!r.error.includes('need SciPy')) failures.push(`dynamic import not explained: ${JSON.stringify(r)}`)
  let recovered = false
  for (let attempt = 0; attempt < 30 && !recovered; attempt++) {
    await page.waitForTimeout(1000)
    r = await run('import importlib\nimportlib.import_module("utilities.atmosphere").stdatm1976(0.0).rho(0.0)')
    recovered = !r.error && parseFloat(r.value) > 1.2
  }
  if (!recovered) failures.push(`dynamic import never recovered: ${JSON.stringify(r)}`)

  // A static import of an original SciPy-backed module installs it on demand.
  r = await run('import utilities.atmosphere as uat\nstd = uat.stdatm1976(0.0)\nround(float(std.T(0.0)), 3), round(float(std.rho(10000.0)), 4)')
  if (r.error || r.value.trim() !== '(288.15, 0.4135)') failures.push(`atmosphere failed: ${JSON.stringify(r)}`)

  r = await run('import utilities.simple_rotor_calcs as rotor\nround(float(rotor.ct(1000.0, 0.0, 2000.0, 5.0)), 6)')
  if (r.error || r.value.trim() !== '0.004885') failures.push(`rotor failed: ${JSON.stringify(r)}`)

  // The same session still runs ordinary commands.
  r = await run('1 + 1')
  if (r.error || r.value.trim() !== '2') failures.push(`session broken after SciPy: ${JSON.stringify(r)}`)

  if (errors.length) failures.push(`page errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (external.length) failures.push(`external requests: ${JSON.stringify(external.slice(0, 3))}`)
  if (failures.length) { console.error(JSON.stringify({ failures }, null, 2)); process.exitCode = 1 }
  else console.log('PASS SciPy loads on demand and the original atmosphere/rotor modules run')
} finally { await browser.close() }
