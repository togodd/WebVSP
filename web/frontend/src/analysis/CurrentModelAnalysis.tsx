import { useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useAnalysis, type Stage } from './store'

const STAGES: Stage[] = ['serializing', 'DegenGeom', 'SurfacePatches', 'python']

/**
 * Geometry analysis of the current model. The work happens in disposable WASM
 * instances (see dualWasmProbe/p1Probe); this window only drives it and shows the
 * summary. Closing it does not touch the model.
 */
export function CurrentModelAnalysis() {
  const t = useT()
  const { open, running, stage, enabled, result, error, close, toggle, run, cancel } = useAnalysis()
  const [pos, setPos] = useState({ x: 24, y: 24 })
  const [help, setHelp] = useState(false)
  const [note, setNote] = useState('')
  const drag = useRef<{ x: number; y: number; start: { x: number; y: number } } | null>(null)

  const report = result?.reports?.[0]
  const rows = useMemo(() => {
    const merged = new Map<string, { name: string; type: string; objects: number; patches: number }>()
    for (const o of report?.DegenGeom?.details ?? []) {
      const row = merged.get(o.geomId) ?? { name: o.name, type: o.type, objects: 0, patches: 0 }
      row.objects += 1
      merged.set(o.geomId, row)
    }
    for (const c of report?.SurfacePatches?.details ?? []) {
      const row = merged.get(c.geomId) ?? { name: c.name, type: '—', objects: 0, patches: 0 }
      row.patches += c.patches
      merged.set(c.geomId, row)
    }
    return [...merged.values()]
  }, [report])

  if (!open) return null

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNote(done)
    } catch {
      setNote(t('analysis.copyFailed'))
    }
    window.setTimeout(() => setNote(''), 2000)
  }

  const download = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'webvsp-analysis.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const stageLabel = (s: Stage) => s === 'idle' || s === 'error' ? t('analysis.stage.idle') : t(`analysis.stage.${s}`)
  const stageIndex = STAGES.indexOf(stage)

  return (
    <div
      className="analysis-window"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      role="dialog"
      aria-label={t('analysis.title')}
      data-testid="analysis-window"
    >
      <div
        className="m-float-title analysis-titlebar"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, start: pos }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          setPos({ x: Math.max(0, d.start.x + e.clientX - d.x), y: Math.max(0, d.start.y + e.clientY - d.y) })
        }}
        onPointerUp={() => { drag.current = null }}
      >
        <span>{t('analysis.title')}</span>
        <span className="results-titlebuttons">
          <button className="ghost" title={t('analysis.help')} aria-label={t('analysis.help')} onClick={() => setHelp((h) => !h)}>?</button>
          <button className="ghost" title={t('analysis.close')} aria-label={t('analysis.close')} onClick={close}>✕</button>
        </span>
      </div>

      {help && <div className="analysis-help">{t('analysis.scopeDetail')}</div>}

      <div className="analysis-body">
        <div className="analysis-status">
          <span className={`analysis-badge${error ? ' bad' : result ? ' good' : ''}`}>
            {error ? t('analysis.unsupported') : result ? t('analysis.supported') : t('analysis.unchecked')}
          </span>
          <span className="analysis-scope">{t('analysis.scope')}</span>
        </div>
        {result && (
          <div className="analysis-meta">
            {t('analysis.modelMeta', { kb: Math.round(result.xmlBytes / 1024), types: result.sourceTypes.join(' · ') })}
          </div>
        )}

        <div className="analysis-options">
          <label><input data-testid="analysis-opt-degen" type="checkbox" checked={enabled.DegenGeom} disabled={running} onChange={(e) => toggle('DegenGeom', e.target.checked)} /> {t('analysis.option.degen')}</label>
          <label><input data-testid="analysis-opt-patches" type="checkbox" checked={enabled.SurfacePatches} disabled={running} onChange={(e) => toggle('SurfacePatches', e.target.checked)} /> {t('analysis.option.patches')}</label>
        </div>

        <div className="analysis-actions">
          <button className="primary" disabled={running} onClick={() => void run()} data-testid="analysis-run">
            {running ? t('analysis.running') : t('analysis.run')}
          </button>
          {running && <button className="ghost" onClick={cancel} data-testid="analysis-cancel">{t('analysis.cancel')}</button>}
        </div>

        {(running || result) && (
          <ol className="analysis-progress" data-testid="analysis-progress">
            {STAGES.filter((s) => s !== 'python' || enabled.DegenGeom || enabled.SurfacePatches).map((s, i) => (
              <li key={s} className={result || stageIndex > i ? 'done' : stage === s ? 'active' : ''}>
                {stageLabel(s)}
              </li>
            ))}
          </ol>
        )}

        {error && (
          <div className="analysis-error" data-testid="analysis-error">
            <div className="analysis-error-title">{t('analysis.error')}</div>
            <div className="analysis-error-text">{error}</div>
            <button className="secondary" onClick={() => void copy(error, t('analysis.copiedError'))}>{t('analysis.copyError')}</button>
          </div>
        )}

        {result && report && (
          <div className="analysis-results" data-testid="analysis-results">
            <div className="analysis-stats">
              <span>{t('analysis.objects')} {report.DegenGeom?.objects ?? 0}</span>
              <span>{t('analysis.patches')} {report.SurfacePatches?.patches ?? 0}</span>
              <span>{t('analysis.seconds', { seconds: (result.durationMs / 1000).toFixed(1) })}</span>
            </div>
            <table className="analysis-table">
              <thead>
                <tr><th>{t('analysis.geom')}</th><th>{t('analysis.type')}</th><th>{t('analysis.objects')}</th><th>{t('analysis.patches')}</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}><td>{r.name}</td><td>{r.type}</td><td>{r.objects}</td><td>{r.patches}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="analysis-meta">{t('analysis.fingerprintOk')} · {result.modelFingerprint}</div>
            <div className="analysis-actions">
              <button className="secondary" onClick={() => void copy(JSON.stringify(result, null, 2), t('analysis.copied'))}>{t('analysis.copy')}</button>
              <button className="ghost" onClick={download}>{t('analysis.download')}</button>
            </div>
          </div>
        )}

        {note && <div className="analysis-note">{note}</div>}
      </div>
    </div>
  )
}
