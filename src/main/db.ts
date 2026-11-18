import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  DEFAULT_GEN_SETTINGS, DEFAULT_TEXT_STYLE,
  type GeneratedVideo, type Library, type Project, type TextTemplate, type VideoAsset
} from '@shared/types'

let db: DatabaseSync

export function openDb(dir: string): DatabaseSync {
  db = new DatabaseSync(join(dir, 'clipforge.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, roots TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      path TEXT NOT NULL, name TEXT NOT NULL, folder TEXT NOT NULL,
      duration REAL NOT NULL, width INTEGER, height INTEGER, fps REAL, codec TEXT, format TEXT,
      size INTEGER NOT NULL, has_audio INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL,
      thumb TEXT, dup_of INTEGER, missing INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
      scenes TEXT,
      UNIQUE(library_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(hash);
    CREATE INDEX IF NOT EXISTS idx_videos_lib ON videos(library_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, library_id INTEGER, data TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outputs (
      id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT NOT NULL, text TEXT NOT NULL,
      duration REAL NOT NULL, size INTEGER NOT NULL, combo TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS used_segments (
      id INTEGER PRIMARY KEY, output_id INTEGER REFERENCES outputs(id) ON DELETE CASCADE,
      video_id INTEGER NOT NULL, start REAL NOT NULL, duration REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_used_video ON used_segments(video_id);
    CREATE TABLE IF NOT EXISTS text_templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, style TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS editor_projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `)
  return db
}

export function getDb(): DatabaseSync { return db }

// ---------- ajustes ----------
export function getSetting<T>(key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
  if (!r) return fallback
  try { return JSON.parse(r.value) as T } catch { return fallback }
}
export function setSetting(key: string, value: unknown): void {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
}

// ---------- bibliotecas ----------
type Row = Record<string, unknown>

export function listLibraries(): Library[] {
  const rows = db.prepare(`
    SELECT l.*, COUNT(v.id) AS cnt, COALESCE(SUM(CASE WHEN v.dup_of IS NOT NULL THEN 1 ELSE 0 END),0) AS dups,
           COALESCE(SUM(v.size),0) AS sz, COALESCE(SUM(v.duration),0) AS dur
    FROM libraries l LEFT JOIN videos v ON v.library_id=l.id GROUP BY l.id ORDER BY l.created_at DESC`).all() as Row[]
  return rows.map((r) => ({
    id: r.id as number, name: r.name as string, roots: JSON.parse(r.roots as string), createdAt: r.created_at as number,
    videoCount: r.cnt as number, duplicateCount: r.dups as number, totalSize: r.sz as number, totalDuration: r.dur as number
  }))
}

export function createLibrary(name: string): number {
  const r = db.prepare('INSERT INTO libraries(name,roots,created_at) VALUES(?,?,?)').run(name, '[]', Date.now())
  return Number(r.lastInsertRowid)
}
export function renameLibrary(id: number, name: string): void { db.prepare('UPDATE libraries SET name=? WHERE id=?').run(name, id) }
export function deleteLibrary(id: number): void { db.prepare('DELETE FROM libraries WHERE id=?').run(id) }
export function addLibraryRoot(id: number, root: string): void {
  const r = db.prepare('SELECT roots FROM libraries WHERE id=?').get(id) as { roots: string } | undefined
  if (!r) return
  const roots: string[] = JSON.parse(r.roots)
  if (!roots.includes(root)) roots.push(root)
  db.prepare('UPDATE libraries SET roots=? WHERE id=?').run(JSON.stringify(roots), id)
}

// ---------- videos ----------
function rowToVideo(r: Row): VideoAsset {
  return {
    id: r.id as number, path: r.path as string, name: r.name as string, folder: r.folder as string,
    duration: r.duration as number, width: r.width as number, height: r.height as number, fps: r.fps as number,
    codec: r.codec as string, format: r.format as string, size: r.size as number, hasAudio: !!r.has_audio,
    hash: r.hash as string, thumb: (r.thumb as string) ?? null, dupOf: (r.dup_of as number) ?? null,
    missing: !!r.missing, libraryId: r.library_id as number, addedAt: r.added_at as number,
    scenes: r.scenes ? JSON.parse(r.scenes as string) : null
  }
}

export function listVideos(libraryId: number, opts: { search?: string; limit?: number; offset?: number } = {}): { items: VideoAsset[]; total: number } {
  const like = `%${(opts.search ?? '').replace(/[%_]/g, '')}%`
  const total = (db.prepare('SELECT COUNT(*) c FROM videos WHERE library_id=? AND name LIKE ?').get(libraryId, like) as { c: number }).c
  const rows = db.prepare('SELECT * FROM videos WHERE library_id=? AND name LIKE ? ORDER BY name LIMIT ? OFFSET ?')
    .all(libraryId, like, opts.limit ?? 200, opts.offset ?? 0) as Row[]
  return { items: rows.map(rowToVideo), total }
}

/** Videos utilizables para generar: sin duplicados ni archivos perdidos. */
export function usableVideos(libraryId: number): VideoAsset[] {
  const rows = db.prepare('SELECT * FROM videos WHERE library_id=? AND dup_of IS NULL AND missing=0').all(libraryId) as Row[]
  return rows.map(rowToVideo)
}

export function getVideo(id: number): VideoAsset | null {
  const r = db.prepare('SELECT * FROM videos WHERE id=?').get(id) as Row | undefined
  return r ? rowToVideo(r) : null
}
export function getVideos(ids: number[]): VideoAsset[] {
  if (!ids.length) return []
  const rows = db.prepare(`SELECT * FROM videos WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]
  return rows.map(rowToVideo)
}

export function videoExists(libraryId: number, path: string): boolean {
  return !!db.prepare('SELECT 1 FROM videos WHERE library_id=? AND path=?').get(libraryId, path)
}

export function insertVideo(v: Omit<VideoAsset, 'id' | 'dupOf' | 'missing' | 'scenes' | 'addedAt'>): number {
  const first = db.prepare('SELECT id FROM videos WHERE library_id=? AND hash=? AND dup_of IS NULL ORDER BY id LIMIT 1').get(v.libraryId, v.hash) as { id: number } | undefined
  const r = db.prepare(`INSERT OR IGNORE INTO videos(library_id,path,name,folder,duration,width,height,fps,codec,format,size,has_audio,hash,thumb,dup_of,missing,added_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(
    v.libraryId, v.path, v.name, v.folder, v.duration, v.width, v.height, v.fps, v.codec, v.format, v.size,
    v.hasAudio ? 1 : 0, v.hash, v.thumb, first?.id ?? null, Date.now())
  return Number(r.lastInsertRowid)
}

export function markMissing(id: number, missing: boolean): void { db.prepare('UPDATE videos SET missing=? WHERE id=?').run(missing ? 1 : 0, id) }
export function deleteVideo(id: number): void { db.prepare('DELETE FROM videos WHERE id=?').run(id) }
export function saveScenes(id: number, scenes: number[]): void { db.prepare('UPDATE videos SET scenes=? WHERE id=?').run(JSON.stringify(scenes), id) }
export function allVideoPaths(libraryId: number): Array<{ id: number; path: string; missing: boolean }> {
  return (db.prepare('SELECT id,path,missing FROM videos WHERE library_id=?').all(libraryId) as Row[]).map((r) => ({ id: r.id as number, path: r.path as string, missing: !!r.missing }))
}
export function countVideos(): number { return (db.prepare('SELECT COUNT(*) c FROM videos').get() as { c: number }).c }

// ---------- proyectos ----------
function rowToProject(r: Row): Project {
  const data = JSON.parse(r.data as string) as Partial<Project>
  return {
    id: r.id as number, name: r.name as string, library: (r.library_id as number) ?? null,
    text: data.text ?? '', style: { ...DEFAULT_TEXT_STYLE, ...data.style },
    settings: { ...DEFAULT_GEN_SETTINGS, ...data.settings }, plan: data.plan ?? null,
    createdAt: r.created_at as number, updatedAt: r.updated_at as number
  }
}
export function listProjects(limit = 100): Project[] {
  return (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[]).map(rowToProject)
}
export function getProject(id: number): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Row | undefined
  return r ? rowToProject(r) : null
}
export function saveProject(p: Partial<Project> & { name: string }): number {
  const data = JSON.stringify({ text: p.text, style: p.style, settings: p.settings, plan: p.plan })
  const now = Date.now()
  if (p.id) {
    db.prepare('UPDATE projects SET name=?, library_id=?, data=?, updated_at=? WHERE id=?').run(p.name, p.library ?? null, data, now, p.id)
    return p.id
  }
  const r = db.prepare('INSERT INTO projects(name,library_id,data,created_at,updated_at) VALUES(?,?,?,?,?)').run(p.name, p.library ?? null, data, now, now)
  return Number(r.lastInsertRowid)
}
export function deleteProject(id: number): void { db.prepare('DELETE FROM projects WHERE id=?').run(id) }

// ---------- salidas y registro de combinaciones ----------
export function recordOutput(o: { projectId: number | null; path: string; text: string; duration: number; size: number; combo: string; segments: Array<{ videoId: number; start: number; duration: number }> }): number {
  const r = db.prepare('INSERT INTO outputs(project_id,path,text,duration,size,combo,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(o.projectId, o.path, o.text, o.duration, o.size, o.combo, Date.now())
  const id = Number(r.lastInsertRowid)
  const ins = db.prepare('INSERT INTO used_segments(output_id,video_id,start,duration) VALUES(?,?,?,?)')
  for (const s of o.segments) ins.run(id, s.videoId, s.start, s.duration)
  return id
}
export function listOutputs(): GeneratedVideo[] {
  return (db.prepare('SELECT * FROM outputs ORDER BY created_at DESC LIMIT 500').all() as Row[]).map((r) => ({
    id: r.id as number, projectId: (r.project_id as number) ?? null, path: r.path as string, text: r.text as string,
    duration: r.duration as number, size: r.size as number, createdAt: r.created_at as number
  }))
}
export function deleteOutput(id: number): void { db.prepare('DELETE FROM outputs WHERE id=?').run(id) }
export function countOutputs(): number { return (db.prepare('SELECT COUNT(*) c FROM outputs').get() as { c: number }).c }
export function usedSegmentsFor(videoIds: number[]): Array<{ videoId: number; start: number; duration: number }> {
  if (!videoIds.length) return []
  const out: Array<{ videoId: number; start: number; duration: number }> = []
  // por lotes para no exceder el límite de variables de SQLite
  for (let i = 0; i < videoIds.length; i += 500) {
    const part = videoIds.slice(i, i + 500)
    const rows = db.prepare(`SELECT video_id,start,duration FROM used_segments WHERE video_id IN (${part.map(() => '?').join(',')})`).all(...part) as Row[]
    for (const r of rows) out.push({ videoId: r.video_id as number, start: r.start as number, duration: r.duration as number })
  }
  return out
}
export function comboExists(combo: string): boolean { return !!db.prepare('SELECT 1 FROM outputs WHERE combo=?').get(combo) }
export function clearUsageHistory(): void { db.exec('DELETE FROM used_segments') }

// ---------- plantillas de texto ----------
export function listTemplates(): TextTemplate[] {
  return (db.prepare('SELECT * FROM text_templates ORDER BY id DESC').all() as Row[]).map((r) => ({
    id: r.id as number, name: r.name as string, style: { ...DEFAULT_TEXT_STYLE, ...JSON.parse(r.style as string) }
  }))
}
export function saveTemplate(name: string, style: unknown): number {
  return Number(db.prepare('INSERT INTO text_templates(name,style) VALUES(?,?)').run(name, JSON.stringify(style)).lastInsertRowid)
}
export function deleteTemplate(id: number): void { db.prepare('DELETE FROM text_templates WHERE id=?').run(id) }

// ---------- proyectos del editor de video ----------
export interface EditorRow { id: number; name: string; data: string; updatedAt: number }
export function listEditorProjects(limit = 100): EditorRow[] {
  return (db.prepare('SELECT id,name,data,updated_at AS updatedAt FROM editor_projects ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as EditorRow[])
}
export function getEditorProject(id: number): EditorRow | null {
  return (db.prepare('SELECT id,name,data,updated_at AS updatedAt FROM editor_projects WHERE id=?').get(id) as unknown as EditorRow | undefined) ?? null
}
export function saveEditorProject(p: { id?: number | null; name: string; data: string }): number {
  const now = Date.now()
  if (p.id) { db.prepare('UPDATE editor_projects SET name=?,data=?,updated_at=? WHERE id=?').run(p.name, p.data, now, p.id); return p.id }
  return Number(db.prepare('INSERT INTO editor_projects(name,data,updated_at) VALUES(?,?,?)').run(p.name, p.data, now).lastInsertRowid)
}
export function deleteEditorProject(id: number): void { db.prepare('DELETE FROM editor_projects WHERE id=?').run(id) }
