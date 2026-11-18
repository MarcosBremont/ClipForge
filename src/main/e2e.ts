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

    // ---------- Editor de video: interacción real con la interfaz ----------
    say('— Editor de video —')
    const vl = await js<{ items: Array<{ id: number; dupOf: number | null }> }>(`window.api.invoke('lib:videos', ${libId}, {})`)
    const ids = vl.items.filter((v) => !v.dupOf).slice(0, 3).map((v) => v.id)
    await js(`(async () => { const c = window.__clipforge; const ed = c.editor.getState(); ed.newProject(); const vs = await window.api.invoke('video:getMany', ${JSON.stringify(ids)}); vs.forEach((v) => ed.addVideo(v)); c.store.getState().go('editor') })()`)
    await sleep(1800); await shot('editor-1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ed = (expr: string): Promise<any> => js(`(() => { const c = window.__clipforge; const s = c.editor.getState(); const p = s.project; return ${expr} })()`)
    const fire = (sel: string, type: string, dx: number, where: 'center' | 'right' | 'left' = 'center', target: 'el' | 'window' = 'el'): Promise<void> =>
      js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no existe ' + ${JSON.stringify(sel)}); const r = el.getBoundingClientRect(); const w = ${JSON.stringify(where)}; const x = (w === 'right' ? r.right - 3 : w === 'left' ? r.left + 3 : r.left + r.width / 2) + ${dx}; const y = r.top + r.height / 2; const t = ${JSON.stringify(target)} === 'window' ? window : el; t.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true })) })()`)
    const key = (k: string, mod = false): Promise<void> => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${mod}, bubbles: true }))`)
    const total0: number = await ed('c.E.totalDuration(p)')
    check('el editor carga los 3 videos en la línea de tiempo', (await ed('p.clips.length')) === 3 && total0 > 5, `total=${total0.toFixed(1)}`)
    check('la página del editor se dibuja (clips y vista previa)', (await js<number>(`document.querySelectorAll('.edclip').length`)) === 3 && (await js<boolean>(`!!document.querySelector('.edphone video')`)))

    // Dividir con la tecla S
    await ed('s.seek(1.5)'); await sleep(200)
    await key('s')
    check('S divide el clip bajo la cabeza de reproducción (4 clips, misma duración)', (await ed('p.clips.length')) === 4 && Math.abs((await ed('c.E.totalDuration(p)')) - total0) < 0.01)

    // Recortar arrastrando el borde derecho del 1.er clip 0,5 s hacia la izquierda
    const pps: number = await ed('s.pps')
    const before: number = await ed('c.E.clipDur(p.clips[0])')
    await fire('.edclip:nth-child(1) .h.r', 'pointerdown', 0, 'right')
    await fire('.edclip:nth-child(1) .h.r', 'pointermove', -0.5 * pps, 'right', 'window')
    await fire('.edclip:nth-child(1) .h.r', 'pointerup', -0.5 * pps, 'right', 'window')
    const after: number = await ed('c.E.clipDur(p.clips[0])')
    check('arrastrar el borde recorta el clip (≈0,5 s menos)', Math.abs(before - after - 0.5) < 0.05, `${before.toFixed(2)} → ${after.toFixed(2)}`)

    // Reordenar arrastrando el 3.er clip hacia el inicio
    const ordBefore: string = await ed('p.clips.map((x) => x.id).join()')
    const third: string = await ed('p.clips[2].id')
    await fire('.edclip:nth-child(3)', 'pointerdown', 0)
    await fire('.edclip:nth-child(3)', 'pointermove', -600, 'center', 'window')
    await fire('.edclip:nth-child(3)', 'pointerup', -600, 'center', 'window')
    const ordAfter: string = await ed('p.clips.map((x) => x.id).join()')
    check('arrastrar un clip cambia el orden', ordBefore !== ordAfter && ordAfter.split(',').indexOf(third) < 2, `posición ${ordAfter.split(',').indexOf(third)}`)

    // Velocidad desde el inspector (clic en el chip 2×)
    await fire('.edclip:nth-child(2)', 'pointerdown', 0); await fire('.edclip:nth-child(2)', 'pointerup', 0, 'center', 'window'); await sleep(250)
    const d2: number = await ed('c.E.clipDur(p.clips[1])')
    await js(`[...document.querySelectorAll('.edright .chip')].find((c) => c.textContent === '2×').click()`); await sleep(250)
    const d2b: number = await ed('c.E.clipDur(p.clips[1])')
    check('el chip 2× duplica la velocidad (la mitad de duración)', Math.abs(d2b - d2 / 2) < 0.02, `${d2.toFixed(2)} → ${d2b.toFixed(2)}`)

    // Texto con la tecla T + edición en el inspector
    await ed('s.seek(0.4)'); await sleep(150)
    await key('t'); await sleep(300)
    await js(`(() => { const ta = document.querySelector('.edright textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'Hola editor'); ta.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(250)
    check('T crea un texto y el inspector lo edita', (await ed('p.texts.length')) === 1 && (await ed('p.texts[0].text')) === 'Hola editor')
    check('el texto empieza donde estaba la cabeza de reproducción', Math.abs((await ed('p.texts[0].start')) - 0.4) < 0.05)

    // Mover el texto arrastrándolo sobre la vista previa
    const x0: number = await ed('p.texts[0].style.x'); const y0: number = await ed('p.texts[0].style.y')
    await js(`(() => { const st = document.querySelector('.edphone'); const b = document.querySelector('.edbox').getBoundingClientRect(); const x = b.left + b.width / 2; const y = b.top + b.height / 2; const f = (t, dx, dy) => st.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: x + dx, clientY: y + dy, pointerId: 1, isPrimary: true })); f('pointerdown', 0, 0); f('pointermove', 40, 90); f('pointerup', 40, 90) })()`)
    await sleep(250)
    const x1: number = await ed('p.texts[0].style.x'); const y1: number = await ed('p.texts[0].style.y')
    check('arrastrar el texto en la vista previa lo mueve', x1 > x0 + 0.02 && y1 > y0 + 0.02, `(${x0.toFixed(2)},${y0.toFixed(2)}) → (${x1.toFixed(2)},${y1.toFixed(2)})`)
    await shot('editor-2')

    // Deshacer / rehacer
    await key('z', true); await sleep(150)
    check('Ctrl+Z deshace el movimiento del texto', Math.abs((await ed('p.texts[0].style.x')) - x0) < 0.01)
    await key('y', true); await sleep(150)
    check('Ctrl+Y lo rehace', Math.abs((await ed('p.texts[0].style.x')) - x1) < 0.01)

    // Reproducción: la cabeza avanza
    await key(' '); await sleep(1500)
    const ph: number = await ed('s.playhead')
    await key(' ')
    check('Espacio reproduce y la cabeza de reproducción avanza', ph > 0.9, `playhead=${ph.toFixed(2)}`)

    // Exportar desde el botón y verificar el archivo
    const totalEd: number = await ed('c.E.totalDuration(p)')
    type RJ = { status: string; result?: { outputs: Array<{ path: string }> }; message?: string }
    const waitRender = (): Promise<RJ> => js<RJ>(`new Promise((res) => { const off = window.api.onJob((p) => { if (p.kind === 'render' && p.status !== 'running') { off(); res(p) } }) })`)
    const jobPromise = waitRender()
    await js(`document.querySelector('.edhead button.primary').click()`)
    const er = await jobPromise
    check('exportar desde el editor termina', er.status === 'done', er.message ?? '')
    const eo = er.result?.outputs[0]?.path
    if (eo) {
      const pi = await probe(eo)
      check('el video del editor es 1080x1920 H.264 con audio y la duración de la línea de tiempo', pi.width === 1080 && pi.height === 1920 && pi.codec === 'h264' && pi.hasAudio && Math.abs(pi.duration - totalEd) < 0.25, `${pi.width}x${pi.height} ${pi.duration.toFixed(2)}s esperado ${totalEd.toFixed(2)}s`)
      const md5 = async (f: string, t: number): Promise<string> => (await run(ffmpegPath(), ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-f', 'md5', '-'])).stdout.trim()
      // sin el texto el mismo instante debe verse distinto
      await ed('s.apply((q) => c.E.removeText(q, q.texts[0].id))')
      const jp2 = waitRender()
      await js(`document.querySelector('.edhead button.primary').click()`)
      const er2 = await jp2
      const eo2 = er2.result?.outputs[0]?.path
      check('la versión sin texto también se exporta', !!eo2)
      if (eo2) check('el texto está realmente dibujado en el video exportado (mismo instante, imagen distinta)', (await md5(eo, 1.2)) !== (await md5(eo2, 1.2)))
    }
    await js(`window.__clipforge.store.getState().go('editor')`); await sleep(500); await shot('editor-3')
  } catch (e) {
    say('EXCEPCION ' + (e instanceof Error ? e.stack : String(e))); failed++
  }
  if (errors.length) say('Errores de consola: ' + errors.join(' | '))
  check('sin errores de consola en la interfaz', errors.length === 0)
  writeFileSync(join(work, 'e2e.log'), log.join('\n'))
  app.exit(failed ? 1 : 0)
}
