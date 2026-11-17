// 工作区：/work 里的文件，像 MATLAB 的 Current Folder 一样列出来。
//
// 浮窗行为与 Python Console 一致（拖标题栏、拖右下角缩放、z-index 45），
// 列表、筛选、排序、预览、下载、删除都在这里；数据来自 workspace/store.ts。
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatSize, formatTime, type WorkspaceFile } from '../api/workspaceFiles'
import { addWorkspaceFiles, chooseWorkspaceFolder, syncWorkspace, useWorkspace } from '../api/pythonWorkspace'
import { FilePreview } from './FilePreview'
import { useWorkspaceFiles, visibleFiles } from './store'

const MIN_W = 420
const MIN_H = 260

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
  const refresh = useWorkspaceFiles((s) => s.refresh)
  const download = useWorkspaceFiles((s) => s.download)
  const remove = useWorkspaceFiles((s) => s.remove)
  const mounted = useWorkspace()

  const [pos, setPos] = useState({ x: 180, y: 90 })
  const [size, setSize] = useState({ w: 620, h: 420 })
  const [preview, setPreview] = useState<WorkspaceFile | null>(null)
  const [pending, setPending] = useState<WorkspaceFile | null>(null)
  const [menu, setMenu] = useState<{ file: WorkspaceFile; x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; pos: { x: number; y: number } } | null>(null)
  const grow = useRef<{ x: number; y: number; size: { w: number; h: number } } | null>(null)

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
      <div
        className="py-console ws-panel"
        style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
        data-testid="workspace-panel"
      >
        <div
          className="py-console-title ws-title"
          onPointerDown={(e) => {
            // Buttons in the title must stay clickable: pointer capture on the bar
            // would swallow their click.
            if ((e.target as HTMLElement).closest('button')) return
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
          <span>工作区 · /work</span>
          <span className="results-titlebuttons">
            <span className="ws-count" data-testid="ws-count">{files.length} 个文件</span>
            <button className="ghost" title="刷新" disabled={busy} onClick={() => void refresh()}>⟳</button>
            <button className="ghost" title="关闭" onClick={close}>✕</button>
          </span>
        </div>

        <div className="py-console-workspace">
          <button className="ghost" disabled={busy || mounted.busy} onClick={() => void chooseWorkspaceFolder()}>选择文件夹</button>
          <button className="ghost" disabled={busy || mounted.busy} onClick={() => void addWorkspaceFiles()}>添加文件</button>
          <button className="ghost" disabled={busy || mounted.busy} onClick={() => void syncWorkspace()}>同步</button>
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
                ? '还没有文件。点「选择文件夹」挂载本地文件夹，或「添加文件」放几个文件进来；也可以直接在 Python Console 里写文件。'
                : '没有匹配的文件。'}
            </div>
          )}
        </div>

        <div className="ws-status">
          <span className="ws-mount">
            {mounted.name ? `已挂载：${mounted.name}（${mounted.files} 个文件${mounted.writable ? '' : '，只读'}）` : '未挂载文件夹；相对路径指向 /work'}
          </span>
          <span className="ws-hint">{message || '双击查看，右键更多操作'}</span>
        </div>

        <div
          className="py-console-resize"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); grow.current = { x: e.clientX, y: e.clientY, size } }}
          onPointerMove={(e) => {
            const g = grow.current
            if (!g) return
            setSize({ w: Math.max(MIN_W, g.size.w + e.clientX - g.x), h: Math.max(MIN_H, g.size.h + e.clientY - g.y) })
          }}
          onPointerUp={() => { grow.current = null }}
        />
      </div>

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
              <div className="ws-hint">文件会从 /work 删除，无法撤销{mounted.name ? '；挂载文件夹里的同名文件也会被删掉' : ''}。</div>
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
