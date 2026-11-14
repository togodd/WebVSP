import { t } from '../i18n'
import { declineOffered, saveOffered, useResultsSave } from '../api/solverResults'

/** Asks to save a finished VSPAERO run's results next to the model, and says when they're saved. */
export function ResultsSaveToast() {
  const { ask, note, failed } = useResultsSave()
  const folderAccess = 'showDirectoryPicker' in window
  if (ask) {
    return (
      <div className="results-toast" role="dialog" aria-label={t('toast.resultsTitle')}>
        <div className="results-toast-text">
          {t('toast.ask', { model: ask.modelName })}
          <span className="results-toast-hint">
            {ask.folder
              ? t('toast.hintFolder', { folder: ask.folder.name })
              : folderAccess
                ? t('toast.hintChoose')
                : t('toast.hintDownload', { count: ask.files.length })}
          </span>
        </div>
        <div className="results-toast-buttons">
          <button onClick={declineOffered}>{t('toast.notNow')}</button>
          <button className="primary" onClick={() => void saveOffered()}>
            {ask.folder ? t('toast.save') : folderAccess ? t('toast.saveEllipsis') : t('toast.download')}
          </button>
        </div>
      </div>
    )
  }
  if (note) {
    return (
      <div className={'results-toast note' + (failed ? ' failed' : '')} role="status">
        {note}
      </div>
    )
  }
  return null
}
