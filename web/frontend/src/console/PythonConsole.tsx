import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import { useConsole } from './consoleStore'
import { addWorkspaceFiles, chooseWorkspaceFolder, syncWorkspace, useWorkspace } from '../api/pythonWorkspace'

const SNIPPETS: { label: string; code: string }[] = [
  { label: 'geoms', code: 'import openvsp as vsp\n[(g, vsp.GetGeomName(g), vsp.GetGeomTypeName(g)) for g in vsp.FindGeoms()]' },
  { label: 'params', code: 'import openvsp as vsp\nw = vsp.FindGeoms()[0]\n[(p["name"], p["group"], p["value"]) for p in map(vsp.GetParmInfo, vsp.GetGeomParmIDs(w))][:20]' },
  { label: 'xsecs', code: 'import openvsp as vsp\nw = vsp.FindGeoms()[0]\nids = vsp.GetXSecIDs(vsp.GetXSecSurfIDs(w)[0])\n[(i, vsp.GetXSecShape(i)) for i in ids]' },
  { label: 'degen', code: 'import openvsp as vsp, degen_geom_parse\nvsp.SetAnalysisInputDefaults("DegenGeom")\nvsp.SetIntAnalysisInput("DegenGeom", "Set", [vsp.SET_ALL])\nroot = vsp.ExecAnalysis("DegenGeom")\n[(o.name, o.type.name) for o in degen_geom_parse.parse_degen_geom(root)]' },
  { label: 'patches', code: 'import openvsp as vsp, surface_patches\ncomps = surface_patches.export_surface_patches(vsp.SET_ALL)\n[(c.name, len(c.surfaces), sum(len(s.patches) for s in c.surfaces)) for c in comps]' },
  { label: 'sets', code: 'import openvsp as vsp\n[(i, vsp.GetSetName(i)) for i in range(vsp.GetNumSets())]' },
]

/** A Python console over the live page model, as a floating window. */
export function PythonConsole() {
  const { open, busy, entries, code, setCode, run, clear, restart, close } = useConsole()
  const [pos, setPos] = useState({ x: 40, y: 60 })
  const [size, setSize] = useState({ w: 720, h: 480 })
  const [historyAt, setHistoryAt] = useState<number | null>(null)
  const drag = useRef<{ x: number; y: number; pos: { x: number; y: number } } | null>(null)
  const grow = useRef<{ x: number; y: number; size: { w: number; h: number } } | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const out = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight
  }, [entries.length, busy])

  const history = useConsole((s) => s.history)
  const workspace = useWorkspace()
  const lines = useMemo(() => entries.flatMap((e) => {
    const parts = [`>>> ${e.code.split('\n').join('\n... ')}`]
    if (e.stdout) parts.push(e.stdout)
    if (e.value) parts.push(e.value)
    if (e.error) parts.push(e.error)
    return parts
  }), [entries])

  if (!open) return null

  return (
    <div
      className="py-console"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, width: size.w, height: size.h }}
      role="dialog"
      aria-label={t('console.title')}
      data-testid="console-window"
    >
      <div
        className="m-float-title py-console-title"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, pos }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          setPos({ x: Math.max(0, d.pos.x + e.clientX - d.x), y: Math.max(0, d.pos.y + e.clientY - d.y) })
        }}
        onPointerUp={() => { drag.current = null }}
      >
        <span>{t('console.title')}</span>
        <span className="results-titlebuttons">
          <button className="ghost" title={t('console.clear')} onClick={clear}>⌫</button>
          <button className="ghost" title={t('console.restart')} onClick={restart} disabled={busy}>⟲</button>
          <button className="ghost" title={t('console.close')} onClick={close}>✕</button>
        </span>
      </div>

      <div className="py-console-workspace">
        <span className="py-console-hint">
          工作区：{workspace.name ? `${workspace.name}（${workspace.files} 个文件${workspace.writable ? '' : '，只读'}）` : '未挂载，相对路径指向 /work'}
        </span>
        <button className="ghost" disabled={workspace.busy} onClick={() => void chooseWorkspaceFolder()}>选择文件夹</button>
        <button className="ghost" disabled={workspace.busy} onClick={() => void addWorkspaceFiles()}>添加文件</button>
        <button className="ghost" disabled={workspace.busy} onClick={() => void syncWorkspace()}>同步</button>
        {workspace.message && <span className="py-console-hint">{workspace.message}</span>}
      </div>

      <div className="py-console-snippets">
        <span className="py-console-hint">{t('console.snippets')}</span>
        {SNIPPETS.map((s) => (
          <button key={s.label} className="ghost" onClick={() => { setCode(s.code); area.current?.focus() }}>{s.label}</button>
        ))}
      </div>

      <div className="py-console-output" ref={out} data-testid="console-output">
        {lines.length === 0 && <div className="py-console-empty">{t('console.help')}</div>}
        {entries.map((e) => (
          <div key={e.id} className="py-console-entry">
            <pre className="py-console-code">{'>>> ' + e.code.replace(/\n/g, '\n... ')}</pre>
            {e.stdout && <pre className="py-console-stdout">{e.stdout}</pre>}
            {e.value && <pre className="py-console-value">{e.value}</pre>}
            {e.error && <pre className="py-console-error">{e.error}</pre>}
            <div className="py-console-meta">{e.ms} ms{e.profile ? ` · ${e.profile.calls} bridge calls · ${Math.round(e.profile.waitMs)} ms bridge wait · ${Math.round(e.profile.responseBytes / 1024)} KiB` : ''}</div>
          </div>
        ))}
        {busy && <div className="py-console-busy">{t('console.running')}</div>}
      </div>

      <textarea
        ref={area}
        className="py-console-input"
        value={code}
        spellCheck={false}
        placeholder={t('console.placeholder')}
        data-testid="console-input"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); return }
          if (e.key === 'ArrowUp' && !code.includes('\n') && history.length) {
            e.preventDefault()
            const next = historyAt === null ? 0 : Math.min(history.length - 1, historyAt + 1)
            setHistoryAt(next)
            setCode(history[next])
          } else if (e.key === 'ArrowDown' && historyAt !== null) {
            e.preventDefault()
            const next = historyAt - 1
            if (next < 0) { setHistoryAt(null); setCode('') } else { setHistoryAt(next); setCode(history[next]) }
          }
        }}
      />
      <div className="py-console-bar">
        <button className="primary" disabled={busy || !code.trim()} onClick={() => void run()} data-testid="console-run">
          {busy ? t('console.running') : t('console.run')}
        </button>
        <span className="py-console-hint">{t('console.hint')}</span>
      </div>
      <div
        className="py-console-resize"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); grow.current = { x: e.clientX, y: e.clientY, size } }}
        onPointerMove={(e) => {
          const g = grow.current
          if (!g) return
          setSize({ w: Math.max(420, g.size.w + e.clientX - g.x), h: Math.max(260, g.size.h + e.clientY - g.y) })
        }}
        onPointerUp={() => { grow.current = null }}
      />
    </div>
  )
}
