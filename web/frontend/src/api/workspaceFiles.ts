// The workspace's file listing: what /work holds, what each file is, and the
// four things the panel does with it (list, preview, download, delete).
//
// Only the engine's file system is listed. Python's own files (matplotlib
// figures, pickles) live in Pyodide's file system and are out of scope for now;
// pythonWorkspace.ts mirrors a chosen folder into /work, so anything mounted
// there shows up here too.
import {
  engineDeleteFile,
  engineListFiles,
  readEngineFile,
  saveEngineFile,
} from './wasmEngine'
import type { EngineFileInfo } from './wasmEngine'

export const WORKSPACE_ROOT = '/work'
/** Preview reads at most this much; bigger files load on demand after a warning. */
export const PREVIEW_LIMIT = 64 * 1024

export type FileKind = 'model' | 'mesh' | 'aero' | 'result' | 'table' | 'text' | 'image' | 'script' | 'archive' | 'other'

export interface WorkspaceFile extends EngineFileInfo {
  /** Path relative to the workspace root, without the leading slash. */
  rel: string
  kind: FileKind
  ext: string
}

interface KindSpec { kind: FileKind; glyph: string; hint: string }

/** Extension → icon and category. The glyphs are the panel's only iconography. */
const KINDS: Record<string, KindSpec> = {
  vsp3: { kind: 'model', glyph: '▣', hint: 'OpenVSP model' },
  vspgeom: { kind: 'mesh', glyph: '◈', hint: 'VSPAERO geometry' },
  vspaero: { kind: 'mesh', glyph: '◈', hint: 'VSPAERO setup' },
  degengeom: { kind: 'mesh', glyph: '◈', hint: 'DegenGeom' },
  adb: { kind: 'result', glyph: '◈', hint: 'VSPAERO solution' },
  history: { kind: 'result', glyph: '◈', hint: 'Solver history' },
  polar: { kind: 'result', glyph: '◈', hint: 'Polar' },
  lod: { kind: 'result', glyph: '◈', hint: 'Loads' },
  csv: { kind: 'table', glyph: '▤', hint: 'Table' },
  dat: { kind: 'table', glyph: '▤', hint: 'Table' },
  tsv: { kind: 'table', glyph: '▤', hint: 'Table' },
  txt: { kind: 'text', glyph: '▤', hint: 'Text' },
  log: { kind: 'text', glyph: '▤', hint: 'Log' },
  json: { kind: 'text', glyph: '▤', hint: 'JSON' },
  xml: { kind: 'text', glyph: '▤', hint: 'XML' },
  md: { kind: 'text', glyph: '▤', hint: 'Markdown' },
  png: { kind: 'image', glyph: '▦', hint: 'Image' },
  jpg: { kind: 'image', glyph: '▦', hint: 'Image' },
  jpeg: { kind: 'image', glyph: '▦', hint: 'Image' },
  svg: { kind: 'image', glyph: '▦', hint: 'Image' },
  gif: { kind: 'image', glyph: '▦', hint: 'Image' },
  webp: { kind: 'image', glyph: '▦', hint: 'Image' },
  py: { kind: 'script', glyph: '◧', hint: 'Python' },
  pckl: { kind: 'archive', glyph: '▪', hint: 'Pickle' },
  zip: { kind: 'archive', glyph: '▪', hint: 'Archive' },
}

export function classify(name: string): KindSpec {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return KINDS[ext] ?? { kind: 'other', glyph: '▪', hint: ext ? ext.toUpperCase() : 'File' }
}

export function isPreviewable(kind: FileKind): boolean {
  return kind === 'text' || kind === 'table' || kind === 'script' || kind === 'image'
}

function toWorkspaceFile(file: EngineFileInfo): WorkspaceFile {
  const rel = file.path.startsWith(WORKSPACE_ROOT + '/') ? file.path.slice(WORKSPACE_ROOT.length + 1) : file.name
  const spec = classify(file.name)
  const dot = file.name.lastIndexOf('.')
  return { ...file, rel, kind: spec.kind, ext: dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '' }
}

/** Every file under the workspace root, sorted by relative path. */
export async function listWorkspace(root = WORKSPACE_ROOT): Promise<WorkspaceFile[]> {
  const files = await engineListFiles(root)
  return files
    .map(toWorkspaceFile)
    .sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' }))
}

export interface TextPreview { text: string; truncated: boolean; size: number }

/** Read a file as text, capped so a 50 MB log cannot freeze the panel. */
export async function readTextPreview(path: string, limit = PREVIEW_LIMIT): Promise<TextPreview> {
  const bytes = await readEngineFile(path)
  const slice = bytes.subarray(0, limit)
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(slice),
    truncated: bytes.length > limit,
    size: bytes.length,
  }
}

/** An object URL for an image file; the caller revokes it. */
export async function readImagePreview(path: string): Promise<string> {
  const bytes = await readEngineFile(path)
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return URL.createObjectURL(new Blob([copy], { type: 'application/octet-stream' }))
}

/** Save the file through the browser's download/directory handling. */
export async function downloadWorkspaceFile(file: WorkspaceFile): Promise<void> {
  await saveEngineFile(file.path, file.name)
}

export async function deleteWorkspaceFile(file: WorkspaceFile): Promise<void> {
  await engineDeleteFile(file.path)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function formatTime(ms: number): string {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
}
