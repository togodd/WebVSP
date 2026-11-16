// Console store helper: one persistent Python session created through the same
// bridge as script mode, so Python calls reach the page engine identically.
import { startConsoleSession, type ConsoleSession } from '../dualWasmProbe/syncProbe'

let session: ConsoleSession | null = null
let starting: Promise<ConsoleSession> | null = null

export async function ensureSession(): Promise<ConsoleSession> {
  if (session) return session
  if (!starting) starting = startConsoleSession().then((s) => { session = s; return s })
  return starting
}

export function resetSession(): void {
  session?.close()
  session = null
  starting = null
}

export type ConsoleRun = { ok: boolean; value: string; stdout: string; error?: string }

export async function runInConsole(code: string): Promise<ConsoleRun> {
  const active = await ensureSession()
  return active.run(code)
}
