import { create } from 'zustand'
import { t } from '../i18n'
import {
  runCurrentModelAnalysis,
  type AnalysisName,
  type AnalysisStage,
  type CurrentModelAnalysisReport,
} from '../dualWasmProbe/p1Probe'

export type Stage = AnalysisStage | 'idle' | 'error'

interface AnalysisState {
  open: boolean
  running: boolean
  stage: Stage
  enabled: Record<AnalysisName, boolean>
  result: CurrentModelAnalysisReport | null
  error: string | null
  controller: AbortController | null
  openWindow: () => void
  close: () => void
  toggle: (analysis: AnalysisName, on: boolean) => void
  run: () => Promise<void>
  cancel: () => void
}

export const useAnalysis = create<AnalysisState>((set, get) => ({
  open: false,
  running: false,
  stage: 'idle',
  enabled: { DegenGeom: true, SurfacePatches: true },
  result: null,
  error: null,
  controller: null,
  openWindow: () => set({ open: true }),
  close: () => {
    if (get().running) get().cancel()
    set({ open: false })
  },
  toggle: (analysis, on) => set((s) => ({ enabled: { ...s.enabled, [analysis]: on }, error: null })),
  run: async () => {
    if (get().running) return
    const analyses = (Object.keys(get().enabled) as AnalysisName[]).filter((a) => get().enabled[a])
    if (!analyses.length) {
      set({ error: t('analysis.needOne'), stage: 'error' })
      return
    }
    const controller = new AbortController()
    set({ running: true, error: null, result: null, stage: 'serializing', controller })
    try {
      const result = await runCurrentModelAnalysis({
        analyses,
        signal: controller.signal,
        onProgress: (stage) => {
          if (get().controller === controller) set({ stage })
        },
      })
      if (get().controller !== controller) return
      set({ running: false, stage: 'done', result, controller: null })
    } catch (error) {
      if (get().controller !== controller) return
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      set({ running: false, stage: aborted ? 'idle' : 'error', error: aborted ? null : error instanceof Error ? error.message : String(error), controller: null })
    }
  },
  cancel: () => {
    const { controller } = get()
    if (!controller) return
    set({ controller: null, running: false, stage: 'idle' })
    controller.abort()
  },
}))
