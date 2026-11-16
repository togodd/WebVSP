// Test all live DeleteGeom clone policies against the actual browser WASM engine.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const base = process.env.WEBVSP_URL ?? 'http://127.0.0.1:4175/'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  const url = new URL(base); url.searchParams.set('dualWasmProbe', '1')
  await page.goto(url.href)
  await page.waitForSelector('[data-ready="1"]', { timeout: 120000 })
  await page.waitForFunction(() => typeof window.__runPython === 'function')
  const code = `
import json
import openvsp as vsp
out = []
for policy in (0, 1, 2):
    pod = vsp.AddGeom('POD')
    clone = vsp.AddGeom('CLONE', pod)
    vsp.Update()
    assert vsp.GetGeomTypeName(clone) == 'Clone'
    try:
        vsp.DeleteGeom(pod, policy)
        outcome = 'ok'
    except vsp.OpenVSPError as e:
        outcome = e.outcome
    remaining = vsp.FindGeoms()
    assert pod not in remaining
    if policy == 0:
        assert outcome == 'unknown' and clone in remaining
        assert vsp.GetGeomTypeName(clone) == 'Clone'
    elif policy == 1:
        assert outcome == 'ok' and clone not in remaining
    else:
        assert outcome == 'ok' and clone in remaining
        assert vsp.GetGeomTypeName(clone) == 'Pod'
    out.append((policy, outcome))
json.dumps(out)
`
  const result = await page.evaluate(code => window.__runPython(code), code)
  assert.deepEqual(typeof result === 'string' ? JSON.parse(result) : result, [[0, 'unknown'], [1, 'ok'], [2, 'ok']])
  console.log('PASS live DeleteGeom clone policies:', result)
} finally { await browser.close() }
