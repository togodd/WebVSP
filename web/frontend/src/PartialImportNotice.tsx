import { dismissPartialImport, usePartialImportNotice } from './api/partialImportNotice'

/** This is not modal and never moves focus; application modal/shortcut handling still applies. */
export function PartialImportNotice() {
  const notices = usePartialImportNotice(state => state.notices)
  const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
  return <section data-partial-import-notice aria-label={zh ? '导入严重警告' : 'Serious import warnings'} style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 10, maxWidth: 'min(460px, 90vw)', maxHeight: '50vh', overflow: 'auto' }}>
    {notices.map(id => <div key={id} role="alert" style={{ background: '#67201c', color: 'white', border: '2px solid #ffaba0', borderRadius: 6, padding: 12, marginTop: 8 }}>
      <strong>{zh ? '导入可能只完成了一部分' : 'Import may have only partially completed'}</strong>
      <p>{zh ? '导入过程中发生错误。内存文件或文件关联可能已改变，无法确定其状态。请检查当前内容和原始文件后再继续。' : 'An error occurred during import. In-memory files or file links may have changed, and their state is uncertain. Check the current contents and original files before continuing.'}</p>
      <button type="button" onClick={() => dismissPartialImport(id)}>{zh ? '关闭警告' : 'Dismiss warning'}</button>
    </div>)}
  </section>
}
