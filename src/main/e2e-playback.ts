// Diagnóstico del reproductor con videos grandes y realistas. Se activa con CLIPFORGE_E2E_PLAYBACK=<carpeta>.
import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ffmpegPath, run } from './ffmpeg'

export async function runPlaybackDiag(win: BrowserWindow, work: string): Promise<void> {
  const out: string[] = []
  const say = (s: string): void => { out.push(s); console.log('[diag]', s) }
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitJob = (id: string): Promise<{ status: string }> => js(`new Promise(res => { const off = window.api.onJob(p => { if (p.jobId === ${JSON.stringify(id)} && p.status !== 'running') { off(); res(p) } }) })`)
  win.webContents.on('console-message', (e) => say(`console[${e.level}] ${e.message}`.slice(0, 300)))
  win.webContents.on('render-process-gone', (_e, d) => say('render-process-gone ' + JSON.stringify(d)))
  win.webContents.on('did-start-navigation', (_e, url) => say('navegación ' + url.slice(0, 80)))
  win.webContents.on('did-finish-load', () => say('did-finish-load'))
  try {
    await sleep(1500)
    const src = join(work, 'src'); mkdirSync(src, { recursive: true })
    // Videos verticales 720x1280 con movimiento, GOP largo y moov AL FINAL (como muchos de TikTok/WhatsApp), 90 s cada uno.
    for (let i = 0; i < 5; i++) {
      const r = await run(ffmpegPath(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 50}`, '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M', '-g', '300', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(src, `tt${i}.mp4`)])
      if (r.code) throw new Error(r.stderr)
    }
    say('videos generados')
    const libId = await js<number>(`window.api.invoke('lib:create','DIAG')`)
    await waitJob(await js<string>(`window.api.invoke('lib:import', ${libId}, [${JSON.stringify(src)}])`))
    const settings = { duration: 20, auto: true, segmentCount: null, segmentLength: null, speed: 'normal', fps: 30, quality: 'media', originalAudio: false, musicPath: null, musicVolume: 0.8, versions: 1, watermark: '', useAI: false }
    const plan = await js<unknown>(`window.api.invoke('plan:make', ${libId}, ${JSON.stringify(settings)})`)
    await js(`(async () => { const s = window.__clipforge.store; s.getState().setDraft({ libraryId: ${libId}, text: 'Prueba', settings: ${JSON.stringify(settings)}, plan: ${JSON.stringify(plan)} }); s.getState().go('crear') })()`)
    await sleep(3000)
    await js(`[...document.querySelectorAll('button')].find(b => /Play/.test(b.textContent)).click()`)
    // Muestrea frames realmente decodificados del video visible.
    say('estado tras play: ' + await js<string>(`JSON.stringify({ page: window.__clipforge.store.getState().page, btn: [...document.querySelectorAll('button')].filter(b => /Play|Pausa/.test(b.textContent)).map(b => b.textContent), slider: document.querySelector('.phone ~ .row input[type=range], input[type=range]').value, videos: [...document.querySelectorAll('.phone video')].map(v => ({ cls: v.className, paused: v.paused, t: v.currentTime, rs: v.readyState })) })`))
    const sample = (): Promise<string> => js<string>(`(() => { const v = [...document.querySelectorAll('.phone video')].find(x => !x.classList.contains('hide')); const q = v.getVideoPlaybackQuality(); return JSON.stringify({ t: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState, seeking: v.seeking, frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, err: v.error && v.error.code, src: v.src.slice(-30) }) })()`)
    // Comprobación de fondo: ¿el video visible está realmente dentro del fragmento que toca según la línea de tiempo?
    const segs = (plan as { segments: Array<{ videoId: number; start: number; duration: number }> }).segments
    let mismatches = 0; let checks = 0
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      const r = await js<{ tl: number; vid: number; ct: number; paused: boolean }>(`(() => { const v = [...document.querySelectorAll('.phone video')].find(x => !x.classList.contains('hide')); const sl = document.querySelector('input[type=range]'); return { tl: +sl.value, vid: +v.dataset.vid, ct: v.currentTime, paused: v.paused } })()`)
      let acc = 0; let idx = 0
      for (let k = 0; k < segs.length; k++) { if (r.tl >= acc) idx = k; acc += segs[k].duration }
      const off = r.tl - segs.slice(0, idx).reduce((a, s) => a + s.duration, 0)
      const exp = segs[idx].start + off
      checks++
      if (r.vid !== segs[idx].videoId || Math.abs(r.ct - exp) > 0.8) { mismatches++; if (mismatches <= 6) say(`DESAJUSTE tl=${r.tl.toFixed(2)} seg#${idx} esperado video ${segs[idx].videoId}@${exp.toFixed(2)} real video ${r.vid}@${r.ct.toFixed(2)} paused=${r.paused}`) }
    }
    say(`comprobaciones de sincronía: ${checks}, desajustes: ${mismatches}`)
    let prev = -1; let stalls = 0
    for (let i = 0; i < 3; i++) {
      await sleep(1000)
      const s = JSON.parse(await sample()) as { frames: number; t: number }
      say(JSON.stringify(s))
      if (i > 0 && s.frames === prev) stalls++
      prev = s.frames
    }
    say(`segundos sin fotogramas nuevos: ${stalls}`)
    const img = await win.webContents.capturePage(); writeFileSync(join(work, 'diag.png'), img.toPNG())
  } catch (e) { say('EXCEPCION ' + (e instanceof Error ? e.stack : String(e))) }
  writeFileSync(join(work, 'diag.log'), out.join('\n'))
  app.exit(0)
}
