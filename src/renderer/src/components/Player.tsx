import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GenSettings, Plan, TextStyle, VideoAsset } from '@shared/types'
import { totalDuration } from '@shared/planner'
import { api, errMsg, fmtTime, mediaUrl } from '../api'
import { useStore } from '../store'
import { CANVAS_H, CANVAS_W, drawText, drawWatermark } from '../textRender'
import VideoPicker from './VideoPicker'

interface Props { plan: Plan; libraryId: number; text: string; style: TextStyle; settings: GenSettings; onPlan: (p: Plan) => void }

export default function Player({ plan, libraryId, text, style, settings, onPlan }: Props): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const [videos, setVideos] = useState<Map<number, VideoAsset>>(new Map())
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [sel, setSel] = useState(0)
  const [picker, setPicker] = useState<null | 'replace' | 'add'>(null)
  const [busy, setBusy] = useState(false)

  const elA = useRef<HTMLVideoElement>(null)
  const elB = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const active = useRef<HTMLVideoElement | null>(null)
  const prepared = useRef<{ uid: string; el: HTMLVideoElement } | null>(null)
  const srcCache = useRef(new Map<number, string>())
  const tRef = useRef(0)
  const playRef = useRef(false)
  const lastTs = useRef(0)
  const curIdx = useRef(-1)

  const segs = plan.segments
  const offs = useMemo(() => { let a = 0; return segs.map((s) => { const o = a; a += s.duration; return o }) }, [segs])
  const total = useMemo(() => totalDuration(segs), [segs])
  const segsRef = useRef(segs); segsRef.current = segs
  const offsRef = useRef(offs); offsRef.current = offs
  const totalRef = useRef(total); totalRef.current = total
  const videosRef = useRef(videos); videosRef.current = videos
  const settingsRef = useRef(settings); settingsRef.current = settings

  // Carga la información de los videos usados en el plan.
  useEffect(() => {
    const ids = [...new Set(segs.map((s) => s.videoId))].filter((id) => !videos.has(id))
    if (!ids.length) return
    void api.getVideos(ids).then((vs) => setVideos((m) => { const n = new Map(m); vs.forEach((v) => n.set(v.id, v)); return n }))
  }, [segs, videos])

  const segAt = useCallback((time: number): number => {
    const o = offsRef.current
    for (let i = o.length - 1; i >= 0; i--) if (time >= o[i]) return i
    return 0
  }, [])

  const setSource = useCallback((el: HTMLVideoElement, videoId: number): void => {
    if (el.dataset.vid === String(videoId)) return
    const v = videosRef.current.get(videoId)
    const src = srcCache.current.get(videoId) ?? (v ? mediaUrl(v.path) : '')
    if (!src) return
    el.dataset.vid = String(videoId)
    el.dataset.proxy = ''
    el.src = src
  }, [])

  // Si Chromium no puede reproducir el formato (MKV, AVI, HEVC…), se crea un proxy ligero y se reintenta.
  useEffect(() => {
    const onErr = async (e: Event): Promise<void> => {
      const el = e.currentTarget as HTMLVideoElement
      const id = Number(el.dataset.vid)
      if (!id || el.dataset.proxy === '1') return
      el.dataset.proxy = '1'
      try {
        notify('Preparando vista previa de un formato no compatible…')
        const p = await api.proxy(id)
        srcCache.current.set(id, mediaUrl(p))
        el.src = mediaUrl(p)
      } catch (err) { notify(errMsg(err), 'err') }
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
    const s = segsRef.current[i]
    if (!s) { prepared.current = null; return }
    const other = active.current === elA.current ? elB.current : elA.current
    if (!other) return
    setSource(other, s.videoId)
    seekWhenReady(other, s.start)
    other.pause()
    prepared.current = { uid: s.uid, el: other }
  }, [setSource])

  const showSeg = useCallback((i: number, off: number, play: boolean): void => {
    const s = segsRef.current[i]
    const a = elA.current; const b = elB.current
    if (!s || !a || !b) return
    const reuse = prepared.current && prepared.current.uid === s.uid ? prepared.current.el : null
    const el = reuse ?? (active.current === a ? b : a)
    setSource(el, s.videoId)
    if (!(reuse && off < 0.05)) seekWhenReady(el, s.start + off)
    el.muted = !settingsRef.current.originalAudio
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
    if (!au || !au.src) return
    if (play) {
      const d = au.duration
      try { au.currentTime = d && isFinite(d) ? time % d : time } catch { /* nada */ }
      void au.play().catch(() => undefined)
    } else au.pause()
  }, [])

  const seek = useCallback((time: number, keepPlaying = playRef.current): void => {
    const tt = Math.max(0, Math.min(time, Math.max(0, totalRef.current - 0.01)))
    tRef.current = tt; setT(tt)
    const i = segAt(tt)
    setSel(i)
    showSeg(i, tt - offsRef.current[i], keepPlaying)
    syncAudio(tt, keepPlaying)
  }, [segAt, showSeg, syncAudio])

  const play = useCallback((): void => {
    if (!segsRef.current.length) return
    if (tRef.current >= totalRef.current - 0.05) tRef.current = 0
    playRef.current = true; setPlaying(true); lastTs.current = performance.now()
    seek(tRef.current, true)
  }, [seek])
  const pause = useCallback((): void => {
    playRef.current = false; setPlaying(false)
    active.current?.pause(); prepared.current?.el.pause(); audio.current?.pause()
  }, [])

  // Bucle de reproducción: el tiempo de la línea de tiempo manda; los <video> se sincronizan a él.
  useEffect(() => {
    let raf = 0
    const tick = (ts: number): void => {
      raf = requestAnimationFrame(tick)
      if (!playRef.current) return
      const dt = Math.min(0.1, (ts - lastTs.current) / 1000)
      lastTs.current = ts
      const nt = tRef.current + dt
      if (nt >= totalRef.current) { pause(); tRef.current = totalRef.current; setT(totalRef.current); return }
      tRef.current = nt; setT(nt)
      const i = segAt(nt)
      if (i !== curIdx.current) { setSel(i); showSeg(i, nt - offsRef.current[i], true) }
      else {
        const el = active.current; const s = segsRef.current[i]
        if (el && s && el.paused && el.readyState >= 2) void el.play().catch((e: Error) => console.warn('play() rechazado (tick):', e.name, e.message))
        // corrige derivas grandes entre el video y la línea de tiempo
        if (el && s && el.readyState >= 2 && Math.abs(el.currentTime - (s.start + nt - offsRef.current[i])) > 0.6) { try { el.currentTime = s.start + nt - offsRef.current[i] } catch { /* nada */ } }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [segAt, showSeg, pause])

  // Cuando cambia el plan (editar/regenerar), reinicia fuentes y reposiciona.
  const planKey = segs.map((s) => s.uid).join(',')
  useEffect(() => {
    prepared.current = null; curIdx.current = -1
    if (!videos.size) return
    seek(Math.min(tRef.current, total), false)
    setPlaying(false); playRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, videos.size > 0])

  useEffect(() => { if (active.current) active.current.muted = !settings.originalAudio }, [settings.originalAudio])
  useEffect(() => {
    const au = audio.current; if (!au) return
    au.volume = settings.musicVolume
    if (settings.musicPath) { au.src = mediaUrl(settings.musicPath); au.loop = true } else { au.removeAttribute('src'); au.load() }
  }, [settings.musicPath, settings.musicVolume])

  // Superposición del texto (mismo dibujado que la exportación).
  useEffect(() => {
    const c = canvas.current; if (!c) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      const w = c.clientWidth * devicePixelRatio
      c.width = w; c.height = w * (CANVAS_H / CANVAS_W)
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, c.width, c.height)
      const visible = style.wholeVideo || (t >= style.startAt && t <= (style.endAt ?? Infinity))
      if (visible) drawText(ctx, text, style, c.width / CANVAS_W)
      drawWatermark(ctx, settings.watermark, c.width / CANVAS_W)
    })
    return () => { cancelled = true }
  }, [text, style, t, settings.watermark])

  useEffect(() => () => { playRef.current = false }, [])

  const guard = async (fn: () => Promise<void>): Promise<void> => { setBusy(true); try { await fn() } catch (e) { notify(errMsg(e), 'err') } finally { setBusy(false) } }
  const cur = segs[sel]
  const move = (d: number): void => {
    const j = sel + d
    if (j < 0 || j >= segs.length) return
    const n = [...segs]; [n[sel], n[j]] = [n[j], n[sel]]
    onPlan({ ...plan, segments: n }); setSel(j)
  }

  return (
    <div className="col">
      <div className="phone">
        <video ref={elA} playsInline preload="auto" className="" />
        <video ref={elB} playsInline preload="auto" className="hide" />
        <canvas ref={canvas} />
        {!segs.length && <div className="ph" />}
      </div>
      <audio ref={audio} />
      <div className="row" style={{ maxWidth: 340, margin: '0 auto', width: '100%' }}>
        <button className="btn sm" title="Fragmento anterior" onClick={() => seek(offs[Math.max(0, segAt(t) - 1)])}>⏮</button>
        <button className="btn sm" title="Retroceder 1 s" onClick={() => seek(t - 1)}>−1s</button>
        <button className="btn primary sm" style={{ minWidth: 70 }} onClick={playing ? pause : play}>{playing ? '⏸ Pausa' : '▶ Play'}</button>
        <button className="btn sm" title="Avanzar 1 s" onClick={() => seek(t + 1)}>+1s</button>
        <button className="btn sm" title="Fragmento siguiente" onClick={() => seek(offs[Math.min(segs.length - 1, segAt(t) + 1)])}>⏭</button>
      </div>
      <div className="row" style={{ maxWidth: 340, margin: '0 auto', width: '100%' }}>
        <input type="range" min={0} max={total} step={0.01} value={t} onChange={(e) => seek(Number(e.target.value))} />
        <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(t)} / {fmtTime(total)}</span>
      </div>

      <div>
        <div className="row sp"><h3 style={{ margin: 0 }}>Línea de tiempo · {segs.length} fragmentos</h3><span className="small muted">Clic en un fragmento para seleccionarlo</span></div>
        <div className="tl">
          {segs.map((s, i) => {
            const v = videos.get(s.videoId)
            return (
              <div key={s.uid} className={'seg' + (i === sel ? ' on' : '') + (i === curIdx.current ? ' cur' : '')} style={{ width: Math.max(58, s.duration * 44) }}
                onClick={() => { setSel(i); seek(offs[i], playRef.current) }} title={v?.name}>
                <div className="t" style={v?.thumb ? { backgroundImage: `url("${mediaUrl(v.thumb)}")` } : undefined} />
                <div className="l">{s.duration.toFixed(1)}s</div>
              </div>
            )
          })}
        </div>
        <div className="row wrap">
          <button className="btn sm" disabled={busy || !cur} onClick={() => guard(async () => onPlan(await api.planReplace(libraryId, settings, plan, sel)))}>🔀 Cambiar por otro</button>
          <button className="btn sm" disabled={!cur} onClick={() => setPicker('replace')}>📁 Elegir de la biblioteca</button>
          <button className="btn sm" onClick={() => setPicker('add')}>＋ Agregar video</button>
          <button className="btn sm" disabled={sel === 0} onClick={() => move(-1)}>◀ Mover</button>
          <button className="btn sm" disabled={sel >= segs.length - 1} onClick={() => move(1)}>Mover ▶</button>
          <button className="btn sm danger" disabled={segs.length <= 1} onClick={() => { onPlan({ ...plan, segments: segs.filter((_, i) => i !== sel) }); setSel(Math.max(0, sel - 1)) }}>🗑 Eliminar</button>
        </div>
        {cur && <div className="small muted" style={{ marginTop: 6 }}>{videos.get(cur.videoId)?.name} · desde {cur.start.toFixed(1)} s · {cur.duration.toFixed(1)} s</div>}
      </div>
      {picker && (
        <VideoPicker libraryId={libraryId} onClose={() => setPicker(null)} onPick={(v) => {
          const mode = picker; setPicker(null)
          void guard(async () => onPlan(await api.planPick(libraryId, settings, plan, v.id, mode === 'replace' ? sel : null)))
        }} />
      )}
    </div>
  )
}
