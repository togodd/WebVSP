// 工作区：/work 里的文件，像 MATLAB 的 Current Folder 一样列出来。
//
// 右侧停靠面板；列表、筛选、排序、预览、下载、删除的数据来自 workspace/store.ts。
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatSize, formatTime, type WorkspaceFile } from '../api/workspaceFiles'
import { FilePreview } from './FilePreview'
import { useWorkspaceFiles, visibleFiles } from './store'
import { openWorkspaceModel } from '../api/openWorkspaceModel'
import { useModelAssociation } from './modelAssociation'

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
  const associatedPath = useModelAssociation((s) => s.path)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState('')
  const [pendingOpen, setPendingOpen] = useState<WorkspaceFile | null>(null)

  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(WIDTH_KEY)
      const saved = raw === null ? NaN : Number(raw)
      return Number.isFinite(saved) ? Math.min(MAX_W, Math.max(MIN_W, saved)) : 420
    } catch { return 420 }
  })
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const maxWidth = Math.min(MAX_W, Math.floor(viewportWidth * (viewportWidth <= 700 ? 0.7 : 0.45)))
  const minWidth = Math.min(MIN_W, maxWidth)
  const actualWidth = Math.min(maxWidth, Math.max(minWidth, width))
  const persistWidth = (value: number) => {
    try { localStorage.setItem(WIDTH_KEY, String(value)) } catch { /* Storage can be unavailable. */ }
  }
  const widthRef = useRef(actualWidth)
  widthRef.current = actualWidth
  const [preview, setPreview] = useState<WorkspaceFile | null>(null)
  const [pending, setPending] = useState<WorkspaceFile | null>(null)
  const [menu, setMenu] = useState<{ file: WorkspaceFile; x: number; y: number } | null>(null)
  const resize = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (width !== actualWidth) setWidth(actualWidth)
  }, [actualWidth, width])

  const descending = useWorkspaceFiles((s) => s.descending)
  const sortLabel = (key: 'name' | 'size' | 'time', label: string) =>
    `${label}，${sort === key ? (descending ? '降序' : '升序') : '未排序'}`
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

  const viewFile = (file: WorkspaceFile) => {
    if (file.kind === 'model') { setOpenError(''); setPendingOpen(file) }
    else setPreview(file)
  }
  const rows = (list: WorkspaceFile[]) => list.map((file) => (
    <div
      key={file.path}
      className="ws-row"
      data-testid={`ws-row-${file.name}`}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) viewFile(file) }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ file, x: e.clientX, y: e.clientY })
      }}
    >
      <span className={`ws-icon ws-kind-${file.kind}`}>{glyph(file.kind)}</span>
      <span className="ws-name" title={file.path}>{file.rel}{file.path === associatedPath && <span className="ws-current"> 当前模型</span>}</span>
      <span className="ws-size">{formatSize(file.size)}</span>
      <span className="ws-time">{formatTime(file.mtime)}</span>
      <span className="ws-ops">
        <button className="ghost ws-action" aria-label={`查看 ${file.name}`} title="查看" onClick={() => viewFile(file)}><Icon name="view" /></button>
        <button className="ghost ws-action" aria-label={`下载 ${file.name}`} title="下载" disabled={busy} onClick={() => void download(file)}><Icon name="download" /></button>
        <button className="ghost ws-action" aria-label={`删除 ${file.name}`} title="删除" disabled={busy} onClick={() => setPending(file)}><Icon name="delete" /></button>
      </span>
    </div>
  ))

  return (
    <>
      <aside className="ws-panel" style={{ width: actualWidth }} data-testid="workspace-panel">
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

        <div className="ws-list" data-testid="ws-list">
          <div className="ws-head">
            <span className="ws-icon" />
            <button className="ws-sort ws-name" aria-label={sortLabel('name', '名称')} onClick={() => setSort('name')}>名称{sort === 'name' ? (descending ? ' ↓' : ' ↑') : ''}</button>
            <button className="ws-sort ws-size" aria-label={sortLabel('size', '大小')} onClick={() => setSort('size')}>大小{sort === 'size' ? (descending ? ' ↓' : ' ↑') : ''}</button>
            <button className="ws-sort ws-time" aria-label={sortLabel('time', '修改时间')} onClick={() => setSort('time')}>修改时间{sort === 'time' ? (descending ? ' ↓' : ' ↑') : ''}</button>
            <span className="ws-ops">操作</span>
          </div>
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
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={actualWidth}
          aria-valuetext={`${actualWidth} 像素`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            setWidth((w) => {
              const next = Math.min(maxWidth, Math.max(minWidth, w + (e.key === 'ArrowLeft' ? 20 : -20)))
              persistWidth(next)
              return next
            })
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            resize.current = { x: e.clientX, width: actualWidth }
          }}
          onPointerMove={(e) => {
            const start = resize.current
            if (start) {
              const next = Math.min(maxWidth, Math.max(minWidth, start.width + start.x - e.clientX))
              widthRef.current = next
              setWidth(next)
            }
          }}
          onPointerUp={() => { resize.current = null; persistWidth(widthRef.current) }}
          onPointerCancel={() => { resize.current = null }}
          onLostPointerCapture={() => { resize.current = null }}
        />
      </aside>

      {menu && (
        <div className="ws-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={() => { viewFile(menu.file); setMenu(null) }}>查看</button>
          <button onClick={() => { void download(menu.file); setMenu(null) }}>下载</button>
          <button className="danger" onClick={() => { setPending(menu.file); setMenu(null) }}>删除</button>
        </div>
      )}

      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}

      {openError && (
        <div className="ws-modal-backdrop" onPointerDown={() => setOpenError('')}>
          <div className="ws-modal" role="alertdialog" aria-label="打开模型失败" onPointerDown={(e) => e.stopPropagation()}>
            <div className="ws-modal-title">打开模型失败</div>
            <div className="ws-modal-body">{openError}<p>读取失败也可能已替换当前模型；请检查当前视图。</p></div>
            <div className="ws-modal-foot"><button onClick={() => setOpenError('')}>关闭</button></div>
          </div>
        </div>
      )}
      {pendingOpen && (
        <div className="ws-modal-backdrop">
          <div className="ws-modal ws-confirm" role="dialog" aria-modal="true" aria-label="打开模型确认">
            <div className="ws-modal-title">打开 {pendingOpen.name}？</div>
            <div className="ws-modal-body">打开将替换当前模型，未保存的更改可能丢失。即使读取失败也可能无法恢复原模型，请先保存重要内容。</div>
            <div className="ws-modal-foot">
              <button className="ghost" disabled={opening} onClick={() => setPendingOpen(null)}>取消</button>
              <button disabled={opening} onClick={async () => {
                if (opening) return
                setOpening(true)
                try { await openWorkspaceModel(pendingOpen.path); setPendingOpen(null) }
                catch (error) { setPendingOpen(null); setOpenError(error instanceof Error ? error.message : String(error)) }
                finally { setOpening(false) }
              }}>{opening ? '正在打开…' : '继续打开'}</button>
            </div>
          </div>
        </div>
      )}
      {pending && (
        <div className="ws-modal-backdrop" onPointerDown={() => setPending(null)}>
          <div className="ws-modal ws-confirm" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="删除文件">
            <div className="ws-modal-title"><span>删除 {pending.name}？</span></div>
            <div className="ws-modal-body">
              <div className="ws-hint">文件会从 /work 删除，无法撤销。{pending.path === associatedPath && ' 这是当前模型关联的文件；删除不会清空内存中的模型，请另存模型以保留更改。'}</div>
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

function Icon({ name }: { name: 'view' | 'download' | 'delete' }) {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'view' && <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>}
    {name === 'download' && <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M4 17v3h16v-3" /></>}
    {name === 'delete' && <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></>}
  </svg>
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
