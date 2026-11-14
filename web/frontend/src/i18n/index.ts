import { useEffect } from 'react'
import { create } from 'zustand'
import { labelText, parseSymbol } from '../mirror/fltk'
import { EN } from './strings_en'
import { ZH } from './strings_zh'
import { VSP_ZH } from './vspDict'
import { MODEL_ZH } from './modelZh'
import { ANALYSIS_ZH } from './analysisZh'

// Keep established shared terminology when screen dictionaries contain the same key.
const MIRROR_ZH: Record<string, string> = { ...MODEL_ZH, ...ANALYSIS_ZH, ...VSP_ZH }

export type Locale = 'en' | 'zh'

const KEY = 'webvsp-locale'

function initialLocale(): Locale {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {
    /* storage unavailable */
  }
  try {
    if (navigator.language.toLowerCase().startsWith('zh')) return 'zh'
  } catch {
    /* ignore */
  }
  return 'en'
}

interface LocaleState {
  locale: Locale
  setLocale: (l: Locale) => void
}

export const useLocale = create<LocaleState>((set) => ({
  locale: initialLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(KEY, locale)
    } catch {
      /* storage unavailable */
    }
    set({ locale })
  },
}))

/** Keep <html lang> in step with the chosen language. */
export function useLocaleLang() {
  const locale = useLocale((s) => s.locale)
  useEffect(() => {
    try {
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    } catch {
      /* ignore */
    }
  }, [locale])
}

const STRINGS: Record<Locale, Record<string, string>> = { en: EN, zh: ZH }

/** WebVSP's own chrome: t('view.fit'). Missing keys fall back to English, then the key. */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = useLocale.getState().locale
  const table = STRINGS[locale] ?? EN
  let s = table[key] ?? EN[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/** Hook version: re-renders the component when the language changes. */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  useLocale((s) => s.locale)
  return t
}

/**
 * An OpenVSP mirrored label for display. Logic comparisons elsewhere keep using the raw
 * English labelText(); only rendering goes through here so Blender keys, View menu routing,
 * "Kill Solver" detection and hidden-item filtering are unaffected.
 */
export function displayLabel(raw: string | undefined): string {
  if (!raw) return ''
  const sym = parseSymbol(raw)
  if (sym) return sym.glyph
  const plain = labelText(raw)
  if (useLocale.getState().locale !== 'zh') return plain
  if (!plain) return ''
  const exact = MIRROR_ZH[plain]
  if (exact !== undefined) return exact
  // Preserve ellipses (which signal that a dialog will open) and surrounding whitespace.
  const match = /^(\s*)(.*?)(\.\.\.|…)?(\s*)$/.exec(plain)
  if (!match) return plain
  const translated = MIRROR_ZH[match[2]]
  return translated === undefined ? plain : `${match[1]}${translated}${match[3] ?? ''}${match[4]}`
}

/** Hook version for mirrored labels: subscribes to language changes. */
export function useDisplayLabel(raw: string | undefined): string {
  useLocale((s) => s.locale)
  return displayLabel(raw)
}

/** A full-sentence prompt message for display; unknown sentences stay in English. */
export function displayMessage(msg: string | undefined): string {
  if (!msg) return ''
  if (useLocale.getState().locale !== 'zh') return msg
  const exact = MIRROR_ZH[msg]
  if (exact !== undefined) return exact
  // These messages interpolate file names; preserve the user-supplied portion verbatim.
  const exportError = /^File export failed\nFile: ([^\n]+)$/.exec(msg)
  if (exportError) return `文件导出失败\n文件：${exportError[1]}`
  const uniqueName = /^([^\n]+) is not unique, use ([^\n]+) instead\?$/.exec(msg)
  if (uniqueName) return `${uniqueName[1]} 不是唯一名称，是否改用 ${uniqueName[2]}？`
  return msg
}
