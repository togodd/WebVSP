import { create } from 'zustand'

interface Run {
  start: number | null
  end: number | null
  code: number | null
}

/**
 * The last VSPAERO run, timed in the VSPAERO window's title bar: when it started, and when and
 * how it ended (code is null while running or if unknown). The run is OpenVSP's whole solver
 * step (writing the geometry, `vspaero`, then `vsploads`): it lasts while Kill Solver is active
 * (`setSolverRunning`, fed from the mirror). How it ended comes from `vspaero`'s exit code
 * (`solverExited`, from wasmEngine.ts; 143 when it's killed).
 */
export const useSolverRun = create<Run>(() => ({ start: null, end: null, code: null }))

/** The run going on: whether vspaero has been launched in it, its exit code once it has exited,
 *  and the last finished run (shown again if this one turns out not to be a run). */
let spawnedId: number | null = null
let ambiguous = false
let exitCode: number | null = null
let previous: Run = { start: null, end: null, code: null }

/** Called when a run ends, with vspaero's exit code, or null if it is not known. */
const endListeners = new Set<(code: number | null) => void>()
export const onSolverEnded = (listener: (code: number | null) => void) => endListeners.add(listener)

export const solverSpawned = (id: number) => {
  // Overlapping launches cannot be attributed confidently to one GUI run.
  if (spawnedId !== null && spawnedId !== id) ambiguous = true
  else spawnedId = id
}
export const solverExited = (id: number, code: number) => {
  // Ignore late exits from an earlier GUI run, including between runs.
  if (spawnedId === id && !ambiguous && exitCode === null) exitCode = code
}

export function setSolverRunning(running: boolean) {
  const run = useSolverRun.getState()
  const timing = run.start !== null && run.end === null
  if (running && !timing) {
    previous = run
    useSolverRun.setState({ start: Date.now(), end: null, code: null })
  } else if (!running && timing) {
    // Kill Solver lit without vspaero being launched (the window appearing): not a run.
    // (OpenVSP launches vspaero just before it lights the button, so these are cleared after a
    // run, not at its start.)
    // A missing exit is not evidence of success; avoid offering stale/partial results.
    const code = ambiguous ? null : exitCode
    const real = spawnedId !== null
    if (!real) useSolverRun.setState(previous)
    else useSolverRun.setState({ end: Date.now(), code })
    spawnedId = null
    ambiguous = false
    exitCode = null
    if (real) endListeners.forEach((l) => l(code))
  }
}
