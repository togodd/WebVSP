import { t, useLocale } from './index'

/** EN / 中文 switch in the top bar. Persists to localStorage, applies instantly. */
export function LanguageSwitch() {
  const locale = useLocale((s) => s.locale)
  const setLocale = useLocale((s) => s.setLocale)
  return (
    <span className="lang-switch" title={t('lang.label')} aria-label={t('lang.label')} role="group">
      <button className={locale === 'en' ? 'on' : undefined} onClick={() => setLocale('en')}>
        EN
      </button>
      <button className={locale === 'zh' ? 'on' : undefined} onClick={() => setLocale('zh')}>
        中文
      </button>
    </span>
  )
}
