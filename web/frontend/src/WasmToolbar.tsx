import { t, useLocale } from './i18n'
import { useStore } from './store'

/** While OpenVSP downloads and starts. */
export function WasmToolbar() {
  const connected = useStore((s) => s.connected)
  useLocale((s) => s.locale)
  if (connected) return null
  return <span className="hint">{t('toolbar.loading')}</span>
}
