import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import {
  DEFAULT_GEN_SETTINGS, VIDEO_EXTENSIONS,
  type AIProviderId, type AppSettings, type DashboardStats, type GenSettings, type Plan, type Project, type TextStyle
} from '@shared/types'
import { comboKey, makePlan, regenerate, replaceSegment, type Range } from '@shared/planner'
import * as ai from './ai'
import * as db from './db'
import { detectScenes } from './ffmpeg'
import { cancelJob, emitProgress, endJob, newJob, pool } from './jobs'
import { importPaths, importUrl, verifyLibrary } from './library'
import { renderEditor } from './editorRender'
import { availableHwEncoders, makeProxy, renderVideo } from './render'
import * as updater from './updater'

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }])

const testDir = process.env.CLIPFORGE_E2E ?? process.env.CLIPFORGE_E2E_PLAYBACK ?? process.env.CLIPFORGE_E2E_UPDATE
if (testDir) app.setPath('userData', join(testDir, 'userdata'))

let win: BrowserWindow | null = null
const dir = (n: string): string => { const p = join(app.getPath('userData'), n); mkdirSync(p, { recursive: true }); return p }

function defaultOutputDir(): string { return join(app.getPath('videos'), 'ClipForge') }

function getAppSettings(): AppSettings {
  return {
    outputDir: db.getSetting('outputDir', defaultOutputDir()),
    activeProvider: ai.activeProvider(),
    hwAccel: db.getSetting('hwAccel', false)
  }
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac'
}

/** Sirve archivos locales con soporte real de peticiones Range (imprescindible para saltar dentro de videos grandes). */
async function mediaHandler(req: Request): Promise<Response> {
  const p = decodeURIComponent(new URL(req.url).pathname.slice(1))
  let size: number
  try { size = (await stat(p)).size } catch { return new Response('No encontrado', { status: 404 }) }
  const base = { 'Content-Type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
  if (!m || (!m[1] && !m[2])) {
    return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
  }
  let start = m[1] ? Number(m[1]) : 0
  let end = m[2] ? Number(m[2]) : size - 1
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1 } // "bytes=-N": últimos N bytes
  end = Math.min(end, size - 1)
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  return new Response(Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream, {
    status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#0e0f13', autoHideMenuBar: true, title: 'ClipForge',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

// ---------- generación por lotes ----------
export interface RenderRequest {
  projectId: number | null
  libraryId: number
  text: string
  style: TextStyle
  settings: GenSettings
  textPng: Uint8Array | null
  watermarkPng: Uint8Array | null
  plan: Plan | null
}

function historyRanges(videoIds: number[]): Range[] { return db.usedSegmentsFor(videoIds) }

function loadScores(libraryId: number): Map<number, number> | undefined {
  const o = db.getSetting<Record<string, number> | null>(`ai.scores.${libraryId}`, null)
  if (!o) return undefined
  return new Map(Object.entries(o).map(([k, v]) => [Number(k), v]))
}

const slug = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'video'

function startRender(req: RenderRequest): string {
  const { id: jobId, ctl } = newJob('render')
  const label = 'Generando video'
  const versions = Math.max(1, Math.min(100, req.settings.versions))
  void (async () => {
    const outputs: Array<{ path: string; id: number }> = []
    const errors: string[] = []
    try {
      const outDir = getAppSettings().outputDir
      mkdirSync(outDir, { recursive: true })
      const videos = db.usableVideos(req.libraryId)
      const used = historyRanges(videos.map((v) => v.id))
      const avoid: Range[] = []
      const scores = req.settings.useAI ? loadScores(req.libraryId) : undefined
      const hw = getAppSettings().hwAccel ? (await availableHwEncoders())[0] : undefined
      for (let v = 1; v <= versions && !ctl.cancelled; v++) {
        const msg = versions > 1 ? `Versión ${v} de ${versions}` : 'Renderizando'
        const base = (v - 1) / versions
        emitProgress({ jobId, kind: 'render', label, done: Math.round(base * 1000), total: 1000, status: 'running', message: msg })
        try {
          let plan: Plan | null = v === 1 ? req.plan : null
          if (!plan) {
            let seed = (Date.now() + v * 7919) >>> 0
            for (let attempt = 0; attempt < 6; attempt++) {
              plan = makePlan({ videos, settings: req.settings, used, avoid, seed, scores })
              if (!db.comboExists(comboKey(plan.segments))) break
              seed = (seed * 1664525 + 1013904223) >>> 0
            }
          }
          if (!plan) throw new Error('No se pudo generar la selección')
          const byId = new Map(db.getVideos([...new Set(plan.segments.map((s) => s.videoId))]).map((x) => [x.id, x]))
          const segs = plan.segments.map((s) => {
            const vid = byId.get(s.videoId)
            if (!vid) throw new Error('Un fragmento usa un video que ya no está en la biblioteca')
            if (!existsSync(vid.path)) throw new Error(`No se encuentra el archivo: ${vid.name}`)
            return { path: vid.path, start: s.start, duration: s.duration, hasAudio: vid.hasAudio }
          })
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
          const outPath = join(outDir, `${slug(req.text)}_${stamp}_v${v}.mp4`)
          const tmpDir = join(dir('tmp'), `${jobId}-${v}`)
          const r = await renderVideo({
            segments: segs, settings: req.settings, style: req.style,
            textPng: req.textPng ? Buffer.from(req.textPng) : null,
            watermarkPng: req.watermarkPng ? Buffer.from(req.watermarkPng) : null,
            outPath, tmpDir,
            onProgress: (f) => emitProgress({ jobId, kind: 'render', label, done: Math.round((base + f / versions) * 1000), total: 1000, status: 'running', message: msg }),
            onSpawn: (p) => { ctl.procs.add(p); p.on('close', () => ctl.procs.delete(p)) },
            isCancelled: () => ctl.cancelled
          }, hw)
          rmSync(tmpDir, { recursive: true, force: true })
          const rec = plan.segments.map((s) => ({ videoId: s.videoId, start: s.start, duration: s.duration }))
          const outId = db.recordOutput({ projectId: req.projectId, path: outPath, text: req.text, duration: r.duration, size: r.size, combo: comboKey(plan.segments), segments: rec })
          avoid.push(...rec)
          outputs.push({ path: outPath, id: outId })
        } catch (e) {
          if (ctl.cancelled) break
          errors.push(`Versión ${v}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const status = ctl.cancelled ? 'cancelled' : outputs.length === 0 ? 'error' : 'done'
      emitProgress({ jobId, kind: 'render', label, done: 1000, total: 1000, status, message: errors.join('\n') || undefined, result: { outputs, errors } })
    } catch (e) {
      emitProgress({ jobId, kind: 'render', label, done: 0, total: 1000, status: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally { endJob(jobId) }
  })()
  return jobId
}

// ---------- exportación del editor de video ----------
export interface EditorExportRequest {
  name: string
  clips: Array<{ videoId: number; srcStart: number; srcEnd: number; speed: number; volume: number }>
  texts: Array<{ png: Uint8Array; start: number; end: number }>
  music: { path: string; volume: number } | null
  fps: 30 | 60
  quality: 'alta' | 'media' | 'rapida'
}

function startEditorExport(req: EditorExportRequest): string {
  const { id: jobId, ctl } = newJob('render')
  const label = 'Exportando desde el editor'
  void (async () => {
    try {
      if (!req.clips.length) throw new Error('La línea de tiempo está vacía')
      const outDir = getAppSettings().outputDir
      mkdirSync(outDir, { recursive: true })
      const byId = new Map(db.getVideos([...new Set(req.clips.map((c) => c.videoId))]).map((x) => [x.id, x]))
      const clips = req.clips.map((c) => {
        const v = byId.get(c.videoId)
        if (!v) throw new Error('Un clip usa un video que ya no está en la biblioteca')
        if (!existsSync(v.path)) throw new Error(`No se encuentra el archivo: ${v.name}`)
        return { path: v.path, srcStart: c.srcStart, srcEnd: Math.min(c.srcEnd, v.duration), speed: c.speed, volume: c.volume, hasAudio: v.hasAudio }
      })
      const hw = getAppSettings().hwAccel ? (await availableHwEncoders())[0] : undefined
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const outPath = join(outDir, `${slug(req.name)}_${stamp}.mp4`)
      const tmpDir = join(dir('tmp'), jobId)
      emitProgress({ jobId, kind: 'render', label, done: 0, total: 1000, status: 'running', message: 'Renderizando' })
      const r = await renderEditor({
        clips, texts: req.texts.map((t) => ({ png: Buffer.from(t.png), start: t.start, end: t.end })), music: req.music,
        fps: req.fps, quality: req.quality, outPath, tmpDir,
        onProgress: (f) => emitProgress({ jobId, kind: 'render', label, done: Math.round(f * 1000), total: 1000, status: 'running', message: 'Renderizando' }),
        onSpawn: (p) => { ctl.procs.add(p); p.on('close', () => ctl.procs.delete(p)) },
        isCancelled: () => ctl.cancelled
      }, hw)
      rmSync(tmpDir, { recursive: true, force: true })
      const outId = db.recordOutput({ projectId: null, path: outPath, text: req.name, duration: r.duration, size: r.size, combo: `editor-${Date.now().toString(36)}`, segments: [] })
      emitProgress({ jobId, kind: 'render', label, done: 1000, total: 1000, status: 'done', result: { outputs: [{ path: outPath, id: outId }], errors: [] } })
    } catch (e) {
      emitProgress({ jobId, kind: 'render', label, done: 0, total: 1000, status: ctl.cancelled ? 'cancelled' : 'error', message: ctl.cancelled ? undefined : e instanceof Error ? e.message : String(e) })
    } finally { endJob(jobId) }
  })()
  return jobId
}

// ---------- análisis de escenas (local) ----------
function analyzeScenes(libraryId: number): string {
  const { id: jobId, ctl } = newJob('analyze')
  const label = 'Detectando cambios de escena'
  void (async () => {
    try {
      const vids = db.usableVideos(libraryId).filter((v) => !v.scenes)
      let done = 0
      await pool(vids, 2, async (v) => {
        try { db.saveScenes(v.id, await detectScenes(v.path)) } catch { /* se omite el video */ }
        done++
        emitProgress({ jobId, kind: 'analyze', label, done, total: vids.length, status: 'running', message: v.name })
      }, () => ctl.cancelled)
      emitProgress({ jobId, kind: 'analyze', label, done: vids.length, total: vids.length, status: ctl.cancelled ? 'cancelled' : 'done' })
    } catch (e) {
      emitProgress({ jobId, kind: 'analyze', label, done: 0, total: 0, status: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally { endJob(jobId) }
  })()
  return jobId
}

function analyzeWithAI(libraryId: number, limit: number): string {
  const { id: jobId, ctl } = newJob('analyze')
  const label = 'Analizando videos con IA'
  void (async () => {
    try {
      const prov = ai.activeProvider()
      if (!prov) throw new Error('Configura y activa un proveedor de IA en el apartado Inteligencia artificial')
      const scores: Record<string, number> = db.getSetting(`ai.scores.${libraryId}`, {} as Record<string, number>)
      const vids = db.usableVideos(libraryId).filter((v) => scores[v.id] === undefined).slice(0, limit)
      const tmp = dir('tmp')
      let done = 0
      let fails = 0
      let lastErr = ''
      await pool(vids, 3, async (v) => {
        try {
          const r = await ai.scoreVideo(prov, v.path, v.duration, tmp)
          if (r) scores[v.id] = r.score
        } catch (e) { fails++; lastErr = e instanceof Error ? e.message : String(e); if (fails >= 3 && done === 0) ctl.cancelled = true }
        done++
        emitProgress({ jobId, kind: 'analyze', label, done, total: vids.length, status: 'running', message: v.name })
      }, () => ctl.cancelled)
      db.setSetting(`ai.scores.${libraryId}`, scores)
      emitProgress({ jobId, kind: 'analyze', label, done: vids.length, total: vids.length, status: fails && done <= fails ? 'error' : ctl.cancelled ? 'cancelled' : 'done', message: fails ? `${fails} fallos. Último: ${lastErr}` : undefined })
    } catch (e) {
      emitProgress({ jobId, kind: 'analyze', label, done: 0, total: 0, status: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally { endJob(jobId) }
  })()
  return jobId
}

// ---------- IPC ----------
function registerIpc(): void {
  const h = (ch: string, fn: (...a: never[]) => unknown): void => { ipcMain.handle(ch, async (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args)) }

  h('app:version', () => app.getVersion())
  h('update:state', () => updater.getState())
  h('update:check', () => updater.checkForUpdates(false))
  h('update:download', () => updater.downloadUpdate())
  h('update:install', () => updater.installUpdate())
  h('app:settings', () => getAppSettings())
  h('app:setOutputDir', (d: string) => { db.setSetting('outputDir', d) })
  h('app:setHwAccel', (v: boolean) => { db.setSetting('hwAccel', v) })
  h('app:hwEncoders', () => availableHwEncoders())
  h('app:stats', (): DashboardStats => ({ videos: db.countVideos(), libraries: db.listLibraries().length, generated: db.countOutputs(), recentProjects: db.listProjects(5) }))

  h('dialog:folder', async () => { const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'multiSelections'] }); return r.canceled ? [] : r.filePaths })
  h('dialog:videos', async () => { const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Videos', extensions: VIDEO_EXTENSIONS.map((e) => e.slice(1)) }] }); return r.canceled ? [] : r.filePaths })
  h('dialog:music', async () => { const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }] }); return r.canceled ? null : r.filePaths[0] })
  h('dialog:outputDir', async () => { const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0] })

  h('lib:list', () => db.listLibraries())
  h('lib:create', (name: string) => db.createLibrary(name))
  h('lib:rename', (id: number, name: string) => db.renameLibrary(id, name))
  h('lib:delete', (id: number) => db.deleteLibrary(id))
  h('lib:videos', (id: number, opts: { search?: string; limit?: number; offset?: number }) => db.listVideos(id, opts))
  h('lib:import', (id: number, paths: string[]) => importPaths(id, paths, dir('thumbs')))
  h('lib:importUrl', (id: number, url: string) => importUrl(id, url, dir('downloads'), dir('thumbs')))
  h('lib:verify', (id: number) => verifyLibrary(id))
  h('lib:removeVideo', (id: number) => db.deleteVideo(id))
  h('lib:analyzeScenes', (id: number) => analyzeScenes(id))
  h('lib:analyzeAI', (id: number, limit: number) => analyzeWithAI(id, limit))
  h('video:getMany', (ids: number[]) => db.getVideos(ids))
  h('video:proxy', async (id: number) => {
    const v = db.getVideo(id)
    if (!v) throw new Error('Video no encontrado')
    return makeProxy(v, dir('proxies'))
  })

  const planInput = (libraryId: number, settings: GenSettings, extraAvoid: Range[] = []) => {
    const videos = db.usableVideos(libraryId)
    return { videos, settings: { ...DEFAULT_GEN_SETTINGS, ...settings }, used: historyRanges(videos.map((v) => v.id)), avoid: extraAvoid, scores: settings.useAI ? loadScores(libraryId) : undefined }
  }
  h('plan:make', (libraryId: number, settings: GenSettings) => makePlan({ ...planInput(libraryId, settings), seed: (Date.now() & 0x7fffffff) }))
  h('plan:regen', (libraryId: number, settings: GenSettings, prev: Plan | null) => regenerate({ ...planInput(libraryId, settings, prev?.segments.map((s) => ({ videoId: s.videoId, start: s.start, duration: s.duration })) ?? []), seed: prev?.seed ?? Date.now() & 0x7fffffff }))
  h('plan:replace', (libraryId: number, settings: GenSettings, plan: Plan, index: number) => { const i = planInput(libraryId, settings); return replaceSegment(plan, index, i.videos, i.used, Date.now() & 0x7fffffff, i.scores) })
  h('plan:pick', (libraryId: number, settings: GenSettings, plan: Plan, videoId: number, index: number | null) => {
    // Añade o sustituye usando un video concreto elegido por el usuario (inicio aleatorio libre).
    const v = db.getVideo(videoId)
    if (!v) return plan
    const len = index !== null ? plan.segments[index].duration : Math.min(1.5, Math.max(0.5, v.duration - 0.2))
    const start = Math.max(0, Math.round(Math.random() * Math.max(0, v.duration - len - 0.1) * 100) / 100)
    const seg = { uid: `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, videoId, start, duration: Math.round(len * 100) / 100 }
    const segs = [...plan.segments]
    if (index !== null) segs[index] = seg
    else segs.push(seg)
    return { ...plan, segments: segs }
  })

  h('render:start', (req: RenderRequest) => startRender(req))
  h('editor:export', (req: EditorExportRequest) => startEditorExport(req))
  h('editor:list', () => db.listEditorProjects())
  h('editor:get', (id: number) => db.getEditorProject(id))
  h('editor:save', (p: { id?: number | null; name: string; data: string }) => db.saveEditorProject(p))
  h('editor:delete', (id: number) => db.deleteEditorProject(id))
  h('job:cancel', (id: string) => cancelJob(id))

  h('project:list', () => db.listProjects())
  h('project:get', (id: number) => db.getProject(id))
  h('project:save', (p: Partial<Project> & { name: string }) => db.saveProject(p))
  h('project:delete', (id: number) => db.deleteProject(id))

  h('output:list', () => db.listOutputs().map((o) => ({ ...o, exists: existsSync(o.path) })))
  h('output:delete', (id: number, removeFile: boolean) => {
    const o = db.listOutputs().find((x) => x.id === id)
    if (o && removeFile) { try { rmSync(o.path, { force: true }) } catch { /* nada */ } }
    db.deleteOutput(id)
  })
  h('output:reveal', (p: string) => { shell.showItemInFolder(p) })
  h('output:open', (p: string) => shell.openPath(p))
  h('history:clear', () => db.clearUsageHistory())

  h('template:list', () => db.listTemplates())
  h('template:save', (name: string, style: TextStyle) => db.saveTemplate(name, style))
  h('template:delete', (id: number) => db.deleteTemplate(id))

  h('ai:providers', () => ai.listProviders())
  h('ai:setKey', (id: AIProviderId, key: string) => ai.setKey(id, key))
  h('ai:setModel', (id: AIProviderId, m: string) => ai.setModel(id, m))
  h('ai:setActive', (id: AIProviderId | null) => ai.setActive(id))
  h('ai:test', async (id: AIProviderId) => ai.testProvider(id))
  h('ai:suggest', async (topic: string) => {
    const p = ai.activeProvider()
    if (!p) throw new Error('Activa un proveedor de IA en el apartado Inteligencia artificial')
    return ai.suggestPhrases(p, topic)
  })

  h('file:exists', (p: string) => existsSync(p))
  h('file:size', (p: string) => { try { return statSync(p).size } catch { return 0 } })
}

app.whenReady().then(() => {
  db.openDb(app.getPath('userData'))
  // Los videos locales se sirven con un protocolo propio que admite rangos (necesario para buscar dentro del video).
  protocol.handle('media', mediaHandler)
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'local-fonts'))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'local-fonts')
  registerIpc()
  createWindow()
  updater.initUpdater()
  if (!process.env.CLIPFORGE_E2E && !process.env.CLIPFORGE_E2E_PLAYBACK && !process.env.CLIPFORGE_E2E_UPDATE && updater.canUpdate()) setTimeout(() => void updater.checkForUpdates(true), 8000)
  const upd = process.env.CLIPFORGE_E2E_UPDATE
  if (upd && win) { const w = win; void import('./e2e-update').then((m) => m.runUpdateE2E(w, upd)) }
  const diag = process.env.CLIPFORGE_E2E_PLAYBACK
  if (diag && win) { const w = win; void import('./e2e-playback').then((m) => m.runPlaybackDiag(w, diag)) }
  const e2e = process.env.CLIPFORGE_E2E
  if (e2e && win) { const w = win; void import('./e2e').then((m) => m.runE2E(w, e2e)) }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
