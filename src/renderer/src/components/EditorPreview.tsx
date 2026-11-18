import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as E from '@shared/editor'
import { api, errMsg, mediaUrl } from '../api'
import { useEditor } from '../editorStore'
import { useStore } from '../store'
import { CANVAS_H, CANVAS_W, drawText, measureBox } from '../textRender'

const clipKey = (c: E.EClip): string => `${c.id}:${c.srcStart}:${c.srcEnd}:${c.speed}`

/** Vista previa del editor: el reloj de la línea de tiempo manda y dos <video> se sincronizan a él (el siguiente se precarga). */
export default function EditorPreview(): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const project = useEditor((s) => s.project)
  const videos = useEditor((s) => s.videos)
  const playhead = useEditor((s) => s.playhead)
  const sel = useEditor((s) => s.sel)
  const seekTick = useEditor((s) => s.seekTick)
  const { select, beginGesture, live, setPlaying, setPlayhead } = useEditor.getState()

  const elA = useRef<HTMLVideoElement>(null)
  const elB = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const warm = useRef<HTMLDivElement>(null)
  const extra = useRef(new Map<string, HTMLAudioElement>()) // pistas de audio extra (efectos, voz)
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLVideoElement | null>(null)
  const prepared = useRef<{ key: string; el: HTMLVideoElement } | null>(null)
  const srcCache = useRef(new Map<number, string>())
  const curIdx = useRef(-1)
  const playRef = useRef(false)
  const lastTs = useRef(0)
  const tRef = useRef(0)
  const projectRef = useRef(project); projectRef.current = project
  const videosRef = useRef(videos); videosRef.current = videos
  const [guides, setGuides] = useState({ v: false, h: false })
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number } | null>(null)
  const [fontsTick, setFontsTick] = useState(0)

  useEffect(() => { void document.fonts.ready.then(() => setFontsTick((n) => n + 1)) }, [])

  const setSource = useCallback((el: HTMLVideoElement, videoId: number): void => {
    if (el.dataset.vid === String(videoId)) return
    const v = videosRef.current[videoId]
    const src = srcCache.current.get(videoId) ?? (v ? mediaUrl(v.path) : '')
    if (!src) return
    el.dataset.vid = String(videoId); el.dataset.proxy = ''; el.src = src
  }, [])

  // Formatos que Chromium no reproduce (MKV, AVI, HEVC…): se crea un proxy ligero y se reintenta.
  useEffect(() => {
    const onErr = async (e: Event): Promise<void> => {
      const el = e.currentTarget as HTMLVideoElement
      const id = Number(el.dataset.vid)
      if (!id || el.dataset.proxy === '1') return
      el.dataset.proxy = '1'
      try { notify('Preparando vista previa de un formato no compatible…'); const p = await api.proxy(id); srcCache.current.set(id, mediaUrl(p)); el.src = mediaUrl(p) } catch (err) { notify(errMsg(err), 'err') }
    }
    const a = elA.current; const b = elB.current
    a?.addEventListener('error', onErr); b?.addEventListener('error', onErr)
    return () => { a?.removeEventListener('error', onErr); b?.removeEventListener('error', onErr) }
  }, [notify])

  const seekWhenReady = (el: HTMLVideoElement, time: number): void => {
    if (el.readyState >= 1) { try { el.currentTime = time } catch { /* aún no listo */ } }
    else el.addEventListener('loadedmetadata', () => { try { el.currentTime = time } catch { /* nada */ } }, { once: true })
  }

  const prepareNext = useCallback((i: number): void => {
    const c = projectRef.current.clips[i]
    if (!c) { prepared.current = null; return }
    const other = active.current === elA.current ? elB.current : elA.current
    if (!other) return
    setSource(other, c.videoId); seekWhenReady(other, c.srcStart); other.pause()
    prepared.current = { key: clipKey(c), el: other }
  }, [setSource])

  const applyClipAudio = (el: HTMLVideoElement, c: E.EClip): void => {
    el.playbackRate = c.speed
    el.volume = Math.max(0, Math.min(1, c.volume))
    el.muted = c.volume <= 0.001
  }

  const showClip = useCallback((i: number, off: number, play: boolean): void => {
    const c = projectRef.current.clips[i]
    const a = elA.current; const b = elB.current
    if (!c || !a || !b) return
    const key = clipKey(c)
    const reuse = prepared.current && prepared.current.key === key ? prepared.current.el : null
    const el = reuse ?? (active.current === a ? b : a)
    setSource(el, c.videoId)
    if (!(reuse && off < 0.05)) seekWhenReady(el, c.srcStart + off * c.speed)
    applyClipAudio(el, c)
    const prev = active.current
    active.current = el
    el.classList.remove('hide')
    if (prev && prev !== el) { prev.pause(); prev.classList.add('hide') }
    if (play) void el.play().catch((e: Error) => console.warn('play() rechazado:', e.name, e.message))
    else el.pause()
    curIdx.current = i
    prepared.current = null
    prepareNext(i + 1)
  }, [setSource, prepareNext])

  const syncAudio = useCallback((time: number, play: boolean): void => {
    const au = audio.current
    const m = projectRef.current.music
    if (!au || !m) return
    au.volume = Math.max(0, Math.min(1, m.volume))
    if (play) {
      const d = au.duration
      try { au.currentTime = d && isFinite(d) ? time % d : time } catch { /* nada */ }
      void au.play().catch(() => undefined)
    } else au.pause()
  }, [])

  /** Fundido (0..1) de un valor en el instante local lt de algo que dura d. */
  const fadeAt = (lt: number, d: number, fi: number, fo: number): number => Math.max(0, Math.min(fi > 0 ? lt / fi : 1, fo > 0 ? (d - lt) / fo : 1, 1))

  /** Sincroniza las pistas de audio extra con el reloj. `hard`: reposicionar (salto); si no, solo arrancar/parar. */
  const syncExtra = useCallback((time: number, play: boolean, hard: boolean): void => {
    const list = projectRef.current.audios ?? []
    const map = extra.current
    for (const [id, el] of map) if (!list.some((a) => a.id === id)) { el.pause(); map.delete(id) }
    for (const a of list) {
      let el = map.get(a.id)
      if (!el) { el = new Audio(mediaUrl(a.path)); el.preload = 'auto'; map.set(a.id, el) }
      const lt = time - a.start
      const inside = lt >= 0 && lt < a.duration
      el.volume = Math.max(0, Math.min(1, a.volume * (inside ? fadeAt(lt, a.duration, a.fadeIn, a.fadeOut) : 1)))
      if (inside && play) {
        if (hard || el.paused) { try { el.currentTime = lt } catch { /* nada */ } }
        if (el.paused) void el.play().catch(() => undefined)
      } else if (!el.paused) el.pause()
    }
  }, [])

  /** Aspecto del clip visible (color, encuadre, fundido): se aplica cada fotograma sobre el <video> activo. */
  const applyLook = useCallback((time: number): void => {
    const p = projectRef.current
    const el = active.current
    const loc = E.locate(p, time)
    if (!el || !loc) return
    const c = p.clips[loc.index]
    const l = E.clipLook(c)
    const f = fadeAt(time - loc.start, E.clipDur(c), l.fadeIn, l.fadeOut)
    el.style.filter = E.hasColor(c) ? `brightness(${1 + l.bright}) contrast(${l.contrast}) saturate(${l.sat})` : ''
    const fr = E.frameAt(c, (time - loc.start) / E.clipDur(c))
    el.style.transform = E.hasFrame(c) ? `translate(${fr.px * 100}%, ${fr.py * 100}%) rotate(${l.rot}deg) scale(${fr.scale}) scaleX(${l.flip ? -1 : 1})` : ''
    el.style.opacity = String(f)
    el.volume = Math.max(0, Math.min(1, c.volume * f))
    const w = warm.current
    if (w) { w.style.background = l.warmth >= 0 ? '#ff8a00' : '#0a7bff'; w.style.opacity = String(Math.abs(l.warmth) * 0.18) }
  }, [])

  const seek = useCallback((time: number, keepPlaying = playRef.current): void => {
    const p = projectRef.current
    const total = E.totalDuration(p)
    const tt = Math.max(0, Math.min(time, Math.max(0, total - 0.01)))
    tRef.current = tt; setPlayhead(tt)
    const loc = E.locate(p, tt)
    if (!loc) { active.current?.pause(); return }
    showClip(loc.index, tt - loc.start, keepPlaying)
    syncAudio(tt, keepPlaying)
    syncExtra(tt, keepPlaying, true)
    applyLook(tt)
  }, [showClip, syncAudio, syncExtra, applyLook, setPlayhead])

  const pause = useCallback((): void => {
    playRef.current = false; setPlaying(false)
    active.current?.pause(); prepared.current?.el.pause(); audio.current?.pause()
    for (const el of extra.current.values()) el.pause()
  }, [setPlaying])
  const play = useCallback((): void => {
    const p = projectRef.current
    if (!p.clips.length) return
    if (tRef.current >= E.totalDuration(p) - 0.05) tRef.current = 0
    playRef.current = true; setPlaying(true); lastTs.current = performance.now()
    seek(tRef.current, true)
  }, [seek, setPlaying])

  // Atajos de reproducción desde fuera (barra de herramientas, teclado): se pide con el estado `playing`.
  const wantPlaying = useEditor((s) => s.playing)
  useEffect(() => { if (wantPlaying && !playRef.current) play(); else if (!wantPlaying && playRef.current) pause() }, [wantPlaying, play, pause])

  // Saltos pedidos (clic en la línea de tiempo, deshacer, abrir proyecto)
  useEffect(() => { prepared.current = null; seek(useEditor.getState().playhead, playRef.current) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [seekTick])

  // Si cambian los clips (recortar, velocidad, orden…) hay que reiniciar fuentes.
  const clipsSig = project.clips.map((c) => clipKey(c) + ':' + c.volume).join(',')
  useEffect(() => {
    prepared.current = null; curIdx.current = -1
    const t = Math.min(useEditor.getState().playhead, E.totalDuration(projectRef.current))
    seek(t, playRef.current)
    if (!projectRef.current.clips.length) { for (const el of [elA.current, elB.current]) { if (el) { el.pause(); el.removeAttribute('src'); delete el.dataset.vid; el.load() } } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipsSig, Object.keys(videos).length])

  useEffect(() => { const au = audio.current; if (au) { au.volume = project.music?.volume ?? 0.8; if (!project.music) au.pause() } }, [project.music])

  // Bucle de reproducción
  useEffect(() => {
    let raf = 0
    const tick = (ts: number): void => {
      raf = requestAnimationFrame(tick)
      if (!playRef.current) return
      const p = projectRef.current
      const total = E.totalDuration(p)
      const dt = Math.min(0.1, (ts - lastTs.current) / 1000)
      lastTs.current = ts
      const nt = tRef.current + dt
      if (nt >= total) { pause(); tRef.current = total; setPlayhead(total); return }
      tRef.current = nt; setPlayhead(nt)
      const loc = E.locate(p, nt)
      if (!loc) return
      syncExtra(nt, true, false)
      if (loc.index !== curIdx.current) showClip(loc.index, nt - loc.start, true)
      else {
        const el = active.current; const c = p.clips[loc.index]
        if (el && c && el.paused && el.readyState >= 2) void el.play().catch(() => undefined)
        if (el && c && el.readyState >= 2 && Math.abs(el.currentTime - loc.src) > 0.6 * Math.max(1, c.speed)) { try { el.currentTime = loc.src } catch { /* nada */ } }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [showClip, pause, setPlayhead, syncExtra])

  // El aspecto (color, encuadre, fundido) se refresca al mover la cabeza o editar el proyecto.
  useEffect(() => { applyLook(playhead); if (!playRef.current) syncExtra(playhead, false, false) }, [playhead, project, applyLook, syncExtra])
  useEffect(() => () => { for (const el of extra.current.values()) el.pause(); extra.current.clear() }, [])

  // ---------- textos sobre la vista previa (mismo dibujado que la exportación) ----------
  const visible = useMemo(() => E.textsAt(project, playhead), [project, playhead])
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const w = Math.max(1, Math.round(c.clientWidth * devicePixelRatio))
    if (c.width !== w) { c.width = w; c.height = Math.round(w * (CANVAS_H / CANVAS_W)) }
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    const k = c.width / CANVAS_W
    for (const t of visible) {
      const a = E.textAnim(t, playhead)
      ctx.save(); ctx.globalAlpha = a.alpha; ctx.translate(a.dx * k, a.dy * k)
      drawText(ctx, t.text, t.style, k)
      ctx.restore()
    }
  }, [visible, fontsTick, playhead])

  const toCanvas = (e: React.PointerEvent): { x: number; y: number } => {
    const r = stage.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * CANVAS_W, y: ((e.clientY - r.top) / r.height) * CANVAS_H }
  }
  const onDown = (e: React.PointerEvent): void => {
    const p = toCanvas(e)
    const hit = [...E.textsAt(projectRef.current, useEditor.getState().playhead)].reverse().find((t) => {
      const b = measureBox(t.text, t.style)
      return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
    })
    if (!hit) { select(null); return }
    select({ kind: 'text', id: hit.id })
    beginGesture()
    drag.current = { id: hit.id, sx: p.x, sy: p.y, ox: hit.style.x, oy: hit.style.y }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* puntero ya liberado */ }
  }
  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const p = toCanvas(e)
    let nx = Math.max(0, Math.min(1, d.ox + (p.x - d.sx) / CANVAS_W))
    let ny = Math.max(0, Math.min(1, d.oy + (p.y - d.sy) / CANVAS_H))
    const gv = Math.abs(nx - 0.5) < 0.012; const gh = Math.abs(ny - 0.5) < 0.012
    if (gv) nx = 0.5
    if (gh) ny = 0.5
    setGuides({ v: gv, h: gh })
    live((pr) => E.setText(pr, d.id, { style: { x: Math.round(nx * 1000) / 1000, y: Math.round(ny * 1000) / 1000 } }))
  }
  const onUp = (): void => { drag.current = null; setGuides({ v: false, h: false }) }

  const selText = sel?.kind === 'text' ? project.texts.find((t) => t.id === sel.id) : undefined
  const selVisible = selText && visible.some((t) => t.id === selText.id)
  const box = selText && selVisible ? measureBox(selText.text, selText.style) : null

  return (
    <div className="edphone" ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <video ref={elA} playsInline preload="auto" />
      <video ref={elB} playsInline preload="auto" className="hide" />
      <div ref={warm} className="edwarm" />
      <canvas ref={canvas} />
      {!project.clips.length && <div className="edempty">Agrega videos de la biblioteca<br />para empezar a editar</div>}
      {box && <div className="edbox" style={{ left: `${(box.x / CANVAS_W) * 100}%`, top: `${(box.y / CANVAS_H) * 100}%`, width: `${(box.w / CANVAS_W) * 100}%`, height: `${(box.h / CANVAS_H) * 100}%` }} />}
      {guides.v && <div className="edguide v" />}
      {guides.h && <div className="edguide h" />}
      <audio ref={audio} src={project.music ? mediaUrl(project.music.path) : undefined} loop />
    </div>
  )
}
