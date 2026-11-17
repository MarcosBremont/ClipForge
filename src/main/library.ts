import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VIDEO_EXTENSIONS } from '@shared/types'
import * as db from './db'
import { makeThumbnail, probe } from './ffmpeg'
import { emitProgress, endJob, newJob, pool } from './jobs'

const EXT = new Set(VIDEO_EXTENSIONS)

export function isVideoFile(p: string): boolean { return EXT.has(extname(p).toLowerCase()) }

async function walk(root: string, out: string[], isCancelled: () => boolean): Promise<void> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (isCancelled()) return
    if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue
    const full = join(root, e.name)
    if (e.isDirectory()) await walk(full, out, isCancelled)
    else if (e.isFile() && isVideoFile(full)) out.push(full)
  }
}

/** Huella rápida: tamaño + 3 bloques del archivo. Evita leer archivos enteros de varios GB. */
export async function quickHash(file: string, size: number): Promise<string> {
  const h = createHash('sha1')
  h.update(String(size))
  const fh = await open(file, 'r')
  try {
    const CH = 128 * 1024
    const buf = Buffer.alloc(CH)
    const offsets = size <= CH * 3 ? [0] : [0, Math.floor(size / 2) - CH / 2, size - CH]
    for (const off of offsets) {
      const { bytesRead } = await fh.read(buf, 0, CH, Math.max(0, off))
      h.update(buf.subarray(0, bytesRead))
    }
  } finally { await fh.close() }
  return h.digest('hex')
}

export interface ImportResult { added: number; duplicates: number; skipped: number; failed: Array<{ file: string; error: string }> }

/** Importa archivos y/o carpetas (recursivo) a una biblioteca. Corre en segundo plano con progreso. */
export function importPaths(libraryId: number, paths: string[], thumbDir: string): string {
  const { id: jobId, ctl } = newJob('import')
  const label = 'Importando videos'
  void (async () => {
    const result: ImportResult = { added: 0, duplicates: 0, skipped: 0, failed: [] }
    try {
      emitProgress({ jobId, kind: 'import', label, done: 0, total: 0, status: 'running', message: 'Buscando videos…' })
      const files: string[] = []
      for (const p of paths) {
        let st
        try { st = await stat(p) } catch { result.failed.push({ file: p, error: 'No se puede acceder a la ruta' }); continue }
        if (st.isDirectory()) { db.addLibraryRoot(libraryId, p); await walk(p, files, () => ctl.cancelled) }
        else if (isVideoFile(p)) files.push(p)
        else result.failed.push({ file: p, error: 'Formato no compatible' })
      }
      const todo = [...new Set(files)].filter((f) => {
        if (db.videoExists(libraryId, f)) { result.skipped++; return false }
        return true
      })
      let done = 0
      mkdirSync(thumbDir, { recursive: true })
      await pool(todo, 4, async (file) => {
        try {
          const st = await stat(file)
          const [info, hash] = await Promise.all([probe(file), quickHash(file, st.size)])
          const thumb = join(thumbDir, `${hash}.jpg`)
          const hasThumb = existsSync(thumb) || (await makeThumbnail(file, thumb, info.duration))
          const before = db.countVideos()
          const id = db.insertVideo({
            libraryId, path: file, name: basename(file), folder: dirname(file), duration: info.duration,
            width: info.width, height: info.height, fps: info.fps, codec: info.codec, format: extname(file).slice(1).toLowerCase() || info.format,
            size: st.size, hasAudio: info.hasAudio, hash, thumb: hasThumb ? thumb : null
          })
          if (db.countVideos() > before) {
            const v = db.getVideo(id)
            if (v?.dupOf) result.duplicates++
            result.added++
          }
        } catch (e) {
          result.failed.push({ file, error: e instanceof Error ? e.message : String(e) })
        }
        done++
        emitProgress({ jobId, kind: 'import', label, done, total: todo.length, status: 'running', message: basename(file) })
      }, () => ctl.cancelled)
      emitProgress({ jobId, kind: 'import', label, done: todo.length, total: todo.length, status: ctl.cancelled ? 'cancelled' : 'done', result })
    } catch (e) {
      emitProgress({ jobId, kind: 'import', label, done: 0, total: 0, status: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally { endJob(jobId) }
  })()
  return jobId
}

/** Descarga un enlace directo a un video (solo si es accesible y es video) y lo importa. */
export function importUrl(libraryId: number, url: string, downloadDir: string, thumbDir: string): string {
  const { id: jobId, ctl } = newJob('import')
  const label = 'Descargando video'
  void (async () => {
    try {
      const u = new URL(url)
      if (!/^https?:$/.test(u.protocol)) throw new Error('Solo se admiten enlaces http(s)')
      emitProgress({ jobId, kind: 'import', label, done: 0, total: 1, status: 'running', message: u.hostname })
      const ac = new AbortController()
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`El servidor respondió ${res.status}`)
      const type = res.headers.get('content-type') ?? ''
      let name = decodeURIComponent(basename(new URL(res.url).pathname)) || 'video'
      if (!isVideoFile(name)) {
        if (type.startsWith('video/')) name += '.' + (type.split('/')[1].split(';')[0].replace('quicktime', 'mov') || 'mp4')
        else throw new Error('El enlace no apunta directamente a un archivo de video (los enlaces de páginas web o plataformas no son compatibles)')
      }
      mkdirSync(downloadDir, { recursive: true })
      const target = join(downloadDir, `${Date.now()}-${name.replace(/[^\w.\- ]/g, '_')}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      let got = 0
      const src = Readable.fromWeb(res.body as never)
      src.on('data', (c: Buffer) => {
        got += c.length
        if (ctl.cancelled) { ac.abort(); src.destroy() }
        emitProgress({ jobId, kind: 'import', label, done: got, total: total || got, status: 'running', message: name })
      })
      await pipeline(src, createWriteStream(target))
      const subId = importPaths(libraryId, [target], thumbDir)
      emitProgress({ jobId, kind: 'import', label, done: 1, total: 1, status: 'done', result: { subJob: subId, added: 0, duplicates: 0, skipped: 0, failed: [] } })
    } catch (e) {
      emitProgress({ jobId, kind: 'import', label, done: 0, total: 1, status: ctl.cancelled ? 'cancelled' : 'error', message: e instanceof Error ? e.message : String(e) })
    } finally { endJob(jobId) }
  })()
  return jobId
}

/** Revisa qué archivos de la biblioteca ya no existen (p. ej. disco externo desconectado). */
export async function verifyLibrary(libraryId: number): Promise<{ missing: number; restored: number }> {
  let missing = 0
  let restored = 0
  for (const v of db.allVideoPaths(libraryId)) {
    const ok = existsSync(v.path)
    if (!ok && !v.missing) { db.markMissing(v.id, true); missing++ }
    else if (ok && v.missing) { db.markMissing(v.id, false); restored++ }
    else if (!ok) missing++
  }
  return { missing, restored }
}
