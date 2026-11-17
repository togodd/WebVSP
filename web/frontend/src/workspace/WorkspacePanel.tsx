// 工作区：/work 里的文件，像 MATLAB 的 Current Folder 一样列出来。
//
// 右侧停靠面板；列表、筛选、排序、预览、下载、删除的数据来自 workspace/store.ts。
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatSize, formatTime, type WorkspaceFile } from '../api/workspaceFiles'
import { FilePreview } from './FilePreview'
import { useWorkspaceFiles, visibleFiles } from './store'

const MIN_W = 300
const MAX_W = 720
const WIDTH_KEY = 'webvsp.workspace.width'

export function WorkspacePanel() {
  const open = useWorkspaceFiles((s) => s.open)
  const close = useWorkspaceFiles((s) => s.close)
  const files = useWorkspaceFiles((s) => s.files)
  const query = useWorkspaceFiles((s) => s.query)
  const setQuery = useWorkspaceFiles((s) => s.setQuery)
  const sort = useWorkspaceFiles((s) => s.sort)
  const setSort = useWorkspaceFiles((s) => s.setSort)
  const busy = useWorkspaceFiles((s) => s.busy)
  const message = useWorkspaceFiles((s) => s.message)
  const download = useWorkspaceFiles((s) => s.download)
  const remove = useWorkspaceFiles((s) => s.remove)

  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(WIDTH_KEY)
      const saved = raw === null ? NaN : Number(raw)
      return Number.isFinite(saved) ? Math.min(MAX_W, Math.max(MIN_W, saved)) : 420
    } catch { return 420 }
  })
  const [preview, setPreview] = useState<WorkspaceFile | null>(null)
  const [pending, setPending] = useState<WorkspaceFile | null>(null)
  const [menu, setMenu] = useState<{ file: WorkspaceFile; x: number; y: number } | null>(null)
  const resize = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)) } catch { /* Storage can be unavailable. */ }
  }, [width])

  const descending = useWorkspaceFiles((s) => s.descending)
  const shown = useMemo(() => visibleFiles({ files, query, sort, descending }), [files, query, sort, descending])

  useEffect(() => {
    if (!menu) return
    const dismiss = () => setMenu(null)
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])

  if (!open) return null

  const rows = (list: WorkspaceFile[]) => list.map((file) => (
    <div
      key={file.path}
      className="ws-row"
      data-testid={`ws-row-${file.name}`}
      onDoubleClick={() => setPreview(file)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ file, x: e.clientX, y: e.clientY })
      }}
    >
      <span className={`ws-icon ws-kind-${file.kind}`}>{glyph(file.kind)}</span>
      <span className="ws-name" title={file.path}>{file.rel}</span>
      <span className="ws-size">{formatSize(file.size)}</span>
      <span className="ws-time">{formatTime(file.mtime)}</span>
      <span className="ws-ops">
        <button className="ghost" onClick={() => setPreview(file)}>查看</button>
        <button className="ghost" disabled={busy} onClick={() => void download(file)}>下载</button>
        <button className="ghost" disabled={busy} onClick={() => setPending(file)}>删除</button>
      </span>
    </div>
  ))

  return (
    <>
      <aside className="ws-panel" style={{ width }} data-testid="workspace-panel">
        <div className="ws-title">
          <span>工作区 · /work</span>
          <span className="results-titlebuttons">
            <span className="ws-count" data-testid="ws-count">{files.length} 个文件</span>
            <button className="ghost" title="关闭" onClick={close}>✕</button>
          </span>
        </div>

        <div className="py-console-workspace">
          <input
            className="ws-search"
            value={query}
            placeholder="按文件名筛选…"
            data-testid="ws-search"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="ws-head">
          <span className="ws-icon" />
          <button className="ws-sort" onClick={() => setSort('name')}>名称{sort === 'name' ? ' ↑' : ''}</button>
          <button className="ws-sort ws-size" onClick={() => setSort('size')}>大小{sort === 'size' ? ' ↓' : ''}</button>
          <button className="ws-sort ws-time" onClick={() => setSort('time')}>修改时间{sort === 'time' ? ' ↓' : ''}</button>
          <span className="ws-ops">操作</span>
        </div>

        <div className="ws-list" data-testid="ws-list">
          {rows(shown)}
          {shown.length === 0 && (
            <div className="ws-empty">
              {files.length === 0
                ? '/work 里还没有文件。'
                : '没有匹配的文件。'}
            </div>
          )}
        </div>

        <div className="ws-status">
          <span className="ws-hint">{message || '双击查看，右键更多操作'}</span>
        </div>

        <div
          className="ws-resize"
          role="separator"
          aria-label="调整工作区宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_W}
          aria-valuemax={MAX_W}
          aria-valuenow={width}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            setWidth((w) => Math.min(MAX_W, Math.max(MIN_W, w + (e.key === 'ArrowLeft' ? 20 : -20))))
          }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); resize.current = { x: e.clientX, width } }}
          onPointerMove={(e) => {
            const start = resize.current
            if (start) setWidth(Math.min(MAX_W, Math.max(MIN_W, start.width + start.x - e.clientX)))
          }}
          onPointerUp={() => { resize.current = null }}
          onPointerCancel={() => { resize.current = null }}
          onLostPointerCapture={() => { resize.current = null }}
        />
      </aside>

      {menu && (
        <div className="ws-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={() => { setPreview(menu.file); setMenu(null) }}>查看</button>
          <button onClick={() => { void download(menu.file); setMenu(null) }}>下载</button>
          <button className="danger" onClick={() => { setPending(menu.file); setMenu(null) }}>删除</button>
        </div>
      )}

      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}

      {pending && (
        <div className="ws-modal-backdrop" onPointerDown={() => setPending(null)}>
          <div className="ws-modal ws-confirm" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="删除文件">
            <div className="ws-modal-title"><span>删除 {pending.name}？</span></div>
            <div className="ws-modal-body">
              <div className="ws-hint">文件会从 /work 删除，无法撤销。</div>
            </div>
            <div className="ws-modal-foot">
              <button className="ghost" onClick={() => setPending(null)}>取消</button>
              <button className="danger" onClick={() => { const f = pending; setPending(null); void remove(f) }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function glyph(kind: WorkspaceFile['kind']): string {
  switch (kind) {
    case 'model': return '▣'
    case 'mesh':
    case 'aero':
    case 'result': return '◈'
    case 'table':
    case 'text': return '▤'
    case 'image': return '▦'
    case 'script': return '◧'
    default: return '▪'
  }
}
