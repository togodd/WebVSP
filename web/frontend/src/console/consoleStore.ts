import { create } from 'zustand'
import { resetSession, runInConsole, type ConsoleRun } from '../dualWasmProbe/pythonConsole'

export interface ConsoleEntry {
  id: number
  code: string
  ok: boolean
  value: string
  stdout: string
  error?: string
  ms: number
  profile?: ConsoleRun['profile']
}

const HISTORY_KEY = 'webvsp.console.history'
const DRAFT_KEY = 'webvsp.console.draft'

function load(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, 50) : []
  } catch { return [] }
}
function save(history: string[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50))) } catch { /* ignore */ }
}

interface ConsoleState {
  open: boolean
  busy: boolean
  entries: ConsoleEntry[]
  history: string[]
  code: string
  openConsole: () => void
  close: () => void
  setCode: (code: string) => void
  run: () => Promise<void>
  clear: () => void
  restart: () => void
}

let nextEntry = 1

export const useConsole = create<ConsoleState>((set, get) => ({
  open: false,
  busy: false,
  entries: [],
  history: load(),
  code: (() => { try { return localStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' } })(),
  openConsole: () => set({ open: true }),
  close: () => set({ open: false }),
  setCode: (code) => {
    set({ code })
    try { localStorage.setItem(DRAFT_KEY, code) } catch { /* ignore */ }
  },
  run: async () => {
    const code = get().code.trim()
    if (!code || get().busy) return
    const history = [code, ...get().history.filter((h) => h !== code)].slice(0, 50)
    save(history)
    set({ busy: true, history })
    const started = performance.now()
    let result: ConsoleRun
    try {
      result = await runInConsole(code, true)
    } catch (error) {
      result = { ok: false, value: '', stdout: '', error: error instanceof Error ? error.message : String(error) }
    }
    set((s) => ({
      busy: false,
      entries: [...s.entries, { id: nextEntry++, code, ...result, ms: Math.round(performance.now() - started) }].slice(-100),
    }))
  },
  clear: () => set({ entries: [] }),
  restart: () => { resetSession(); set({ entries: [], busy: false }) },
}))
