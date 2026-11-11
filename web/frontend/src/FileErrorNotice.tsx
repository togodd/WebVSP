import { useFileNotice } from './api/fileNotice'

/** Non-interactive live region: does not take focus or intercept modal/keyboard input. */
export function FileErrorNotice() {
  const notice = useFileNotice((s) => s.notice)
  const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
  const operation = notice?.operation === 'save' ? (zh ? '另存为' : 'Save As') : (zh ? '打开' : 'Open')
  const message = notice && (notice.kind === 'busy'
    ? zh ? `${operation}已拒绝：该关联文件可能有未写回的更改，或无法检查其状态。请稍后重试；这不表示保存已成功。` : `${operation} was rejected: the linked file may have changes awaiting write-back, or its state could not be checked. Try again later; this does not confirm that saving succeeded.`
    : zh ? `${operation}文件失败。请检查文件并重试。` : `${operation} failed. Check the file and try again.`)
  return <div role="status" aria-live="polite" aria-atomic="true" style={{ position: 'fixed', bottom: 16, right: 16, maxWidth: 'min(420px, 90vw)', zIndex: 10, pointerEvents: 'none' }}>
    {notice && <div style={{ background: '#542a1b', color: 'white', border: '1px solid #edac80', borderRadius: 6, padding: '12px 16px', overflowWrap: 'anywhere' }}>{message}{notice.name && <div>{notice.name}</div>}</div>}
  </div>
}
