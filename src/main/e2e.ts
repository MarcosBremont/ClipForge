// Prueba de integración de extremo a extremo. Solo se activa con CLIPFORGE_E2E=<carpeta de trabajo>.
import { app, type BrowserWindow } from 'electron'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ffmpegPath, probe, run } from './ffmpeg'

export async function runE2E(win: BrowserWindow, work: string): Promise<void> {
  const log: string[] = []
  const errors: string[] = []
  const say = (s: string): void => { log.push(s); console.log('[e2e]', s) }
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message) })
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>
  const shot = async (name: string): Promise<void> => { const img = await win.webContents.capturePage(); writeFileSync(join(work, name + '.png'), img.toPNG()) }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitJob = (id: string): Promise<{ status: string; result?: unknown; message?: string }> => js(`new Promise(res => { const off = window.api.onJob(p => { if (p.jobId === ${JSON.stringify(id)} && p.status !== 'running') { off(); res(p) } }) })`)
  let failed = 0
  const check = (name: string, cond: boolean, extra = ''): void => { say(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!cond) failed++ }

  try {
    await sleep(1500)
    const src = join(work, 'src'); const nested = join(src, 'sub', 'deep')
    mkdirSync(nested, { recursive: true })
    const gen = async (file: string, spec: string, sec: number, audio: boolean): Promise<void> => {
      const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `${spec}:rate=30`]
      if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=${300 + sec * 40}`, '-c:a', 'aac')
      args.push('-t', String(sec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file)
      const r = await run(ffmpegPath(), args); if (r.code) throw new Error(r.stderr)
    }
    const specs = ['testsrc=size=1280x720', 'testsrc2=size=1920x1080', 'smptebars=size=720x1280', 'mandelbrot=size=640x360', 'life=size=800x800', 'rgbtestsrc=size=1280x720']
    for (let i = 0; i < specs.length; i++) await gen(join(i % 2 ? nested : src, `clip${i}${i === 3 ? '.mkv' : '.mp4'}`), specs[i], 6 + i, i % 2 === 0)
    copyFileSync(join(src, 'clip0.mp4'), join(src, 'copy_of_clip0.mp4')) // duplicado exacto
    writeFileSync(join(src, 'notes.txt'), 'no es video')

    await js(`window.api.invoke('app:setOutputDir', ${JSON.stringify(join(work, 'out'))})`)
    const libId = await js<number>(`window.api.invoke('lib:create','E2E')`)
    const jobId = await js<string>(`window.api.invoke('lib:import', ${libId}, [${JSON.stringify(src)}])`)
    const imp = await waitJob(jobId)
    const ir = imp.result as { added: number; duplicates: number; failed: unknown[] }
    check('importación recursiva termina', imp.status === 'done')
    check('importa 7 archivos (6 + copia)', ir.added === 7, `added=${ir.added}`)
    check('detecta 1 duplicado', ir.duplicates === 1, `dups=${ir.duplicates}`)
    const libs = await js<Array<{ videoCount: number; duplicateCount: number }>>(`window.api.invoke('lib:list')`)
    check('biblioteca refleja conteos', libs[0].videoCount === 7 && libs[0].duplicateCount === 1)
    const list = await js<{ items: Array<{ thumb: string | null; duration: number; width: number }>; total: number }>(`window.api.invoke('lib:videos', ${libId}, {})`)
    check('todas con miniatura', list.items.every((v) => v.thumb))
    // reimportar no debe duplicar
    const j2 = await js<string>(`window.api.invoke('lib:import', ${libId}, [${JSON.stringify(src)}])`)
    await waitJob(j2)
    const libs2 = await js<Array<{ videoCount: number }>>(`window.api.invoke('lib:list')`)
    check('reimportar no duplica registros', libs2[0].videoCount === 7)

    const settings = { duration: 10, auto: true, segmentCount: null, segmentLength: null, speed: 'normal', fps: 30, quality: 'rapida', originalAudio: true, musicPath: null, musicVolume: 0.8, versions: 3, watermark: '@miusuario', useAI: false }
    const plan = await js<{ segments: Array<{ duration: number }> }>(`window.api.invoke('plan:make', ${libId}, ${JSON.stringify(settings)})`)
    check('plan generado con suma 10 s', Math.abs(plan.segments.reduce((a, s) => a + s.duration, 0) - 10) < 0.06, `n=${plan.segments.length}`)

    // UI: abrir proyecto con plan y capturar pantallas
    await js(`(async () => { const s = window.__clipforge.store; s.getState().setDraft({ libraryId: ${libId}, text: '¿Será que soy un mal hombre?', settings: ${JSON.stringify(settings)}, plan: ${JSON.stringify(plan)} }); s.getState().go('crear') })()`)
    await sleep(3500)
    await shot('crear')
    const vstate = await js<string>(`JSON.stringify([...document.querySelectorAll('.phone video')].map(v => ({ src: !!v.src, ready: v.readyState, err: v.error && v.error.code })))`)
    check('reproductor carga fuentes de video', /"src":true/.test(vstate), vstate)
    await js(`[...document.querySelectorAll('button')].find(b => /Play/.test(b.textContent)).click()`)
    await sleep(1800)
    const adv = await js<number>(`document.querySelectorAll('.phone video')[0].currentTime + document.querySelectorAll('.phone video')[1].currentTime`)
    check('al pulsar play los videos avanzan', adv > 0.1, `t=${adv.toFixed(2)}`)
    await shot('crear-play')
    for (const p of ['inicio', 'biblioteca', 'plantillas', 'ia', 'config']) { await js(`window.__clipforge.store.getState().go('${p}')`); await sleep(700); await shot(p) }

    // render por lotes (3 versiones) con el texto renderizado por el mismo código que usa la UI
    const png = await js<number[]>(`(async () => { const st = window.__clipforge.store.getState().draft.style; return Array.from(await window.__clipforge.textOverlayPng('¿Será que soy un mal hombre?', st)) })()`)
    const wm = await js<number[]>(`(async () => Array.from(await window.__clipforge.watermarkPng('@miusuario')))()`)
    const style = await js<unknown>(`window.__clipforge.store.getState().draft.style`)
    const rj = await js<string>(`window.api.invoke('render:start', { projectId: null, libraryId: ${libId}, text: '¿Será que soy un mal hombre?', style: ${JSON.stringify(style)}, settings: ${JSON.stringify(settings)}, textPng: new Uint8Array(${JSON.stringify(png)}), watermarkPng: new Uint8Array(${JSON.stringify(wm)}), plan: ${JSON.stringify(plan)} })`)
    const rr = await waitJob(rj)
    const outs = (rr.result as { outputs: Array<{ path: string }>; errors: string[] }).outputs
    check('lote de 3 versiones renderizado', rr.status === 'done' && outs.length === 3, `${outs.length} salidas ${rr.message ?? ''}`)
    for (const o of outs) {
      const pi = await probe(o.path)
      check(`salida válida ${o.path.split(/[\\/]/).pop()}`, pi.width === 1080 && pi.height === 1920 && pi.codec === 'h264' && pi.hasAudio && Math.abs(pi.duration - 10) < 0.2, `${pi.width}x${pi.height} ${pi.duration.toFixed(2)}s`)
    }
    const outRows = await js<Array<{ id: number }>>(`window.api.invoke('output:list')`)
    check('salidas registradas en la base de datos', outRows.length === 3)
    // segunda tanda debe evitar fragmentos del historial
    const plan2 = await js<{ segments: Array<{ videoId: number; start: number; duration: number }> }>(`window.api.invoke('plan:make', ${libId}, ${JSON.stringify(settings)})`)
    check('segundo plan generado tras historial', plan2.segments.length > 1)
    await js(`window.__clipforge.store.getState().go('generados')`); await sleep(900); await shot('generados')
    // proyecto: guardado y recuperación
    const pid = await js<number>(`window.api.invoke('project:save', { name: 'E2E', library: ${libId}, text: 'hola', plan: ${JSON.stringify(plan)} })`)
    const pj = await js<{ text: string; plan: { segments: unknown[] } }>(`window.api.invoke('project:get', ${pid})`)
    check('proyecto se guarda y recupera con su plan', pj.text === 'hola' && pj.plan.segments.length === plan.segments.length)
  } catch (e) {
    say('EXCEPCION ' + (e instanceof Error ? e.stack : String(e))); failed++
  }
  if (errors.length) say('Errores de consola: ' + errors.join(' | '))
  check('sin errores de consola en la interfaz', errors.length === 0)
  writeFileSync(join(work, 'e2e.log'), log.join('\n'))
  app.exit(failed ? 1 : 0)
}
