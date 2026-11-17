// Preview a workspace file in the page: text and images inline, everything else
// gets an explanation and a download button.
import { useEffect, useState } from 'react'
import {
  PREVIEW_LIMIT,
  formatSize,
  isPreviewable,
  readImagePreview,
  readTextPreview,
  type WorkspaceFile,
} from '../api/workspaceFiles'
import { useWorkspaceFiles } from './store'

type Loaded =
  | { state: 'text'; text: string; truncated: boolean; size: number }
  | { state: 'image'; url: string; size: number }
  | { state: 'binary'; size: number }
  | { state: 'loading' }
  | { state: 'error'; message: string }

export function FilePreview({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const download = useWorkspaceFiles((s) => s.download)

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    setLoaded({ state: 'loading' })
    void (async () => {
      try {
        if (!isPreviewable(file.kind)) {
          setLoaded({ state: 'binary', size: file.size })
          return
        }
        if (file.kind === 'image') {
          url = await readImagePreview(file.path)
          if (!cancelled) setLoaded({ state: 'image', url, size: file.size })
          return
        }
        const preview = await readTextPreview(file.path)
        if (!cancelled) setLoaded({ state: 'text', ...preview })
      } catch (error) {
        if (!cancelled) setLoaded({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file])

  return (
    <div className="ws-modal-backdrop" onPointerDown={onClose}>
      <div className="ws-modal" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={`预览 ${file.name}`}>
        <div className="ws-modal-title">
          <span className="ws-icon">{file.rel.endsWith(file.name) ? glyphFor(file.kind) : '▪'}</span>
          <span className="ws-modal-name" title={file.path}>{file.rel}</span>
          <span className="ws-hint">{formatSize(file.size)}</span>
          <button className="ghost" onClick={onClose} title="关闭">✕</button>
        </div>

        <div className="ws-modal-body">
          {loaded.state === 'loading' && <div className="ws-hint">读取中…</div>}
          {loaded.state === 'error' && <div className="ws-error">{loaded.message}</div>}
          {loaded.state === 'binary' && (
            <div className="ws-hint">二进制文件，无法在页面内预览（{formatSize(loaded.size)}）。下载后用桌面工具打开。</div>
          )}
          {loaded.state === 'image' && <img className="ws-preview-image" src={loaded.url} alt={file.name} />}
          {loaded.state === 'text' && (
            <>
              <pre className="ws-preview-text">{loaded.text}</pre>
              {loaded.truncated && (
                <div className="ws-hint">只显示前 {formatSize(PREVIEW_LIMIT)}，原文件 {formatSize(loaded.size)}。</div>
              )}
            </>
          )}
        </div>

        <div className="ws-modal-foot">
          <button className="primary" onClick={() => void download(file)}>下载</button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

/** The row's glyph, repeated here so the preview header matches the list. */
function glyphFor(kind: WorkspaceFile['kind']): string {
  switch (kind) {
    case 'model': return '▣'
    case 'mesh':
    case 'aero': return '◈'
    case 'result': return '◈'
    case 'table': return '▤'
    case 'text': return '▤'
    case 'image': return '▦'
    case 'script': return '◧'
    default: return '▪'
  }
}
