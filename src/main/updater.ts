import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateState =
  | { status: 'idle' }
  | { status: 'unavailable'; message: string }
  | { status: 'checking' }
  | { status: 'none' }
  | { status: 'available'; version: string; notes: string }
  | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

let state: UpdateState = { status: 'idle' }
let silent = false

function set(s: UpdateState): void {
  state = s
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:state', s)
}

export const getState = (): UpdateState => state

const friendly = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e)
  if (/404|Not Found|latest\.yml|Cannot find/i.test(m)) return 'No se encontró ninguna versión publicada todavía (revisa que el repositorio de actualizaciones y el release existan y sean públicos).'
  if (/ENOTFOUND|ECONN|ETIMEDOUT|network|net::/i.test(m)) return 'No hay conexión con el servidor de actualizaciones.'
  return m.split('\n')[0].slice(0, 220)
}

export function initUpdater(): void {
  autoUpdater.logger = console
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  // Para pruebas: servidor propio (generic) en lugar de GitHub.
  const feed = process.env.CLIPFORGE_UPDATE_URL
  if (feed) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: 'generic', url: feed }) }

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('update-available', (i) => {
    const notes = typeof i.releaseNotes === 'string' ? i.releaseNotes.replace(/<[^>]+>/g, '').trim() : ''
    set({ status: 'available', version: i.version, notes })
  })
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => {
    // En la comprobación automática al arrancar no molestamos con errores de red/publicación.
    if (silent) { silent = false; set({ status: 'idle' }); return }
    set({ status: 'error', message: friendly(e) })
  })
}

export function canUpdate(): boolean { return app.isPackaged || !!process.env.CLIPFORGE_UPDATE_URL }

export async function checkForUpdates(isSilent = false): Promise<UpdateState> {
  if (!canUpdate()) { set({ status: 'unavailable', message: 'Las actualizaciones solo funcionan en la versión instalada, no en modo desarrollo.' }); return state }
  silent = isSilent
  try { await autoUpdater.checkForUpdates() } catch (e) { if (!isSilent) set({ status: 'error', message: friendly(e) }) }
  silent = false
  return state
}

export async function downloadUpdate(): Promise<void> {
  try { set({ status: 'downloading', percent: 0 }); await autoUpdater.downloadUpdate() } catch (e) { set({ status: 'error', message: friendly(e) }) }
}

export function installUpdate(): void { autoUpdater.quitAndInstall(false, true) }
