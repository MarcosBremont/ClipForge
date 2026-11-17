// Prueba del flujo de actualización contra un servidor local (CLIPFORGE_UPDATE_URL). Se activa con CLIPFORGE_E2E_UPDATE=<carpeta>.
import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as updater from './updater'

export async function runUpdateE2E(win: BrowserWindow, work: string): Promise<void> {
  const out: string[] = []
  const say = (s: string): void => { out.push(s); console.log('[upd]', s) }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (st: string, ms = 90000): Promise<boolean> => { for (let t = 0; t < ms; t += 200) { if (updater.getState().status === st) return true; if (updater.getState().status === 'error') return false; await sleep(200) } return false }
  const seen: string[] = []
  win.webContents.on('ipc-message', () => undefined)
  try {
    await sleep(1500)
    say('versión instalada: ' + app.getVersion())
    void updater.checkForUpdates(false)
    const found = await waitFor('available')
    const s = updater.getState()
    say(`OK   encuentra actualización: ${found} ${JSON.stringify(s)}`)
    if (!found) throw new Error('no se encontró: ' + JSON.stringify(s))
    void updater.downloadUpdate()
    const ready = await waitFor('ready')
    say(`OK   descarga y verifica sha512: ${ready} ${JSON.stringify(updater.getState())}`)
    seen.push(String(ready))
    if (!ready) throw new Error('descarga falló')
    // Con el servidor ya con la misma versión que la instalada, no debe ofrecer nada: se comprueba aparte.
  } catch (e) { say('FAIL ' + (e instanceof Error ? e.message : String(e))) }
  writeFileSync(join(work, 'update.log'), out.join('\n'))
  app.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0)
}
