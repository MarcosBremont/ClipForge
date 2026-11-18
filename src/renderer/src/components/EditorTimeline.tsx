import { useEffect, useMemo, useRef } from 'react'
import * as E from '@shared/editor'
import { mediaUrl } from '../api'
import { useEditor } from '../editorStore'

const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120]
const fmt = (s: number): string => { const m = Math.floor(s / 60); const r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${Math.floor(r)}` }

/** Línea de tiempo: regla, pistas de texto / video / música, cabeza de reproducción y edición arrastrando. */
export default function EditorTimeline(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const pps = useEditor((s) => s.pps)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const sel = useEditor((s) => s.sel)
  const videos = useEditor((s) => s.videos)
  const scroller = useRef<HTMLDivElement>(null)

  const total = E.totalDuration(project)
  const starts = useMemo(() => E.clipStarts(project), [project])
  const width = Math.max(total * pps + 260, 700)
  const step = STEPS.find((s) => s * pps >= 70) ?? 120

  // Carriles de texto: los que se solapan en el tiempo van en filas distintas.
  const lanes = useMemo(() => {
    const ends: number[] = []
    const lane = new Map<string, number>()
    for (const t of [...project.texts].sort((a, b) => a.start - b.start)) {
      let k = ends.findIndex((e) => e <= t.start + 1e-6)
      if (k < 0) { k = ends.length; ends.push(0) }
      ends[k] = t.start + t.duration
      lane.set(t.id, k)
    }
    return { lane, count: Math.max(1, ends.length) }
  }, [project.texts])

  const timeAt = (clientX: number): number => {
    const sc = scroller.current!
    return Math.max(0, (clientX - sc.getBoundingClientRect().left + sc.scrollLeft) / pps)
  }

  // Seguir la cabeza de reproducción mientras se reproduce
  useEffect(() => {
    const sc = scroller.current
    if (!sc || !playing) return
    const x = playhead * pps
    if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 80)
  }, [playhead, playing, pps])

  // Ctrl + rueda = zoom
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const st = useEditor.getState()
      st.setZoom(st.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [])

  const gesture = (e: React.PointerEvent, onMove: (dx: number, ev: PointerEvent) => void, onStart?: () => void, threshold = 0): void => {
    e.stopPropagation()
    const x0 = e.clientX
    let started = threshold === 0
    if (started) onStart?.()
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - x0
      if (!started) { if (Math.abs(dx) < threshold) return; started = true; onStart?.() }
      onMove(dx / useEditor.getState().pps, ev)
    }
    const up = (): void => { window.removeEventListener('pointermove', move) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  const scrub = (e: React.PointerEvent): void => {
    const st = useEditor.getState()
    st.setPlaying(false)
    st.select(null)
    st.seek(timeAt(e.clientX))
    const move = (ev: PointerEvent): void => useEditor.getState().seek(timeAt(ev.clientX))
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true })
  }

  const clipDown = (e: React.PointerEvent, c: E.EClip, i: number): void => {
    const st = useEditor.getState()
    st.select({ kind: 'clip', id: c.id })
    st.setPlaying(false)
    st.seek(timeAt(e.clientX))
    let idx = i
    gesture(e, (_dx, ev) => {
      const t = timeAt(ev.clientX)
      const p = useEditor.getState().project
      let acc = 0
      let target = 0
      for (const o of p.clips) { if (o.id === c.id) continue; const d = E.clipDur(o); if (t > acc + d / 2) target++; acc += d }
      if (target !== idx) { const from = idx; idx = target; useEditor.getState().live((pr) => E.moveClip(pr, from, target)) }
    }, () => useEditor.getState().beginGesture(), 5)
  }

  const trim = (e: React.PointerEvent, c: E.EClip, side: 'start' | 'end'): void => {
    const st = useEditor.getState()
    st.select({ kind: 'clip', id: c.id }); st.setPlaying(false)
    const asset = videos[c.videoId]?.duration ?? Math.max(c.srcEnd, 1)
    const base = side === 'start' ? c.srcStart : c.srcEnd
    gesture(e, (dx) => useEditor.getState().live((p) => E.trimClip(p, c.id, side, base + dx * c.speed, asset)), () => useEditor.getState().beginGesture())
  }

  const textDown = (e: React.PointerEvent, t: E.EText): void => {
    const st = useEditor.getState()
    st.select({ kind: 'text', id: t.id }); st.setPlaying(false); st.seek(Math.max(t.start, Math.min(timeAt(e.clientX), t.start + t.duration - 0.01)))
    gesture(e, (dx) => {
      const s = useEditor.getState()
      const pts = E.snapPoints(s.project, s.playhead, t.id)
      const thr = 8 / s.pps
      const a = E.snap(t.start + dx, pts, thr)
      const b = E.snap(t.start + dx + t.duration, pts, thr) - t.duration
      const want = a !== t.start + dx ? a : b !== t.start + dx ? b : t.start + dx
      s.live((p) => E.moveText(p, t.id, want))
    }, () => useEditor.getState().beginGesture(), 3)
  }

  const textEdge = (e: React.PointerEvent, t: E.EText, side: 'start' | 'end'): void => {
    useEditor.getState().select({ kind: 'text', id: t.id })
    const base = side === 'start' ? t.start : t.start + t.duration
    gesture(e, (dx) => {
      const s = useEditor.getState()
      const v = E.snap(base + dx, E.snapPoints(s.project, s.playhead, t.id), 8 / s.pps)
      s.live((p) => E.resizeText(p, t.id, side, v))
    }, () => useEditor.getState().beginGesture())
  }

  const ticks: number[] = []
  for (let t = 0; t <= width / pps; t += step) ticks.push(t)
  const textTrackH = lanes.count * 30 + 8

  return (
    <div className="edtl">
      <div className="edgutter">
        <div style={{ height: 26 }} />
        <div className="lbl" style={{ height: textTrackH }}>Texto</div>
        <div className="lbl" style={{ height: 64 }}>Video</div>
        <div className="lbl" style={{ height: 34 }}>Música</div>
      </div>
      <div className="edscroll" ref={scroller}>
        <div className="edcanvas" style={{ width }}>
          <div className="edruler" onPointerDown={scrub}>
            {ticks.map((t) => <span key={t} className="tick" style={{ left: t * pps }}>{fmt(t)}</span>)}
          </div>

          <div className="edtrack" style={{ height: textTrackH }} onPointerDown={scrub}>
            {project.texts.map((t) => (
              <div key={t.id} className={'edtext' + (sel?.kind === 'text' && sel.id === t.id ? ' on' : '')}
                style={{ left: t.start * pps, width: Math.max(14, t.duration * pps), top: 4 + (lanes.lane.get(t.id) ?? 0) * 30 }}
                onPointerDown={(e) => textDown(e, t)}>
                <i className="h l" onPointerDown={(e) => textEdge(e, t, 'start')} />
                <span>T  {t.text || '(vacío)'}</span>
                <i className="h r" onPointerDown={(e) => textEdge(e, t, 'end')} />
              </div>
            ))}
          </div>

          <div className="edtrack" style={{ height: 64 }} onPointerDown={scrub}>
            {project.clips.map((c, i) => {
              const v = videos[c.videoId]
              const on = sel?.kind === 'clip' && sel.id === c.id
              return (
                <div key={c.id} className={'edclip' + (on ? ' on' : '')}
                  style={{ left: starts[i] * pps, width: Math.max(10, E.clipDur(c) * pps), backgroundImage: v?.thumb ? `url("${mediaUrl(v.thumb)}")` : undefined }}
                  onPointerDown={(e) => clipDown(e, c, i)}>
                  <i className="h l" onPointerDown={(e) => trim(e, c, 'start')} />
                  <span className="nm">{v?.name ?? 'video'}</span>
                  <span className="meta">{E.clipDur(c).toFixed(1)}s{c.speed !== 1 ? ` · ${c.speed}×` : ''}{c.volume <= 0.001 ? ' · 🔇' : ''}</span>
                  <i className="h r" onPointerDown={(e) => trim(e, c, 'end')} />
                </div>
              )
            })}
          </div>

          <div className="edtrack" style={{ height: 34 }} onPointerDown={scrub}>
            {project.music
              ? <div className={'edmusic' + (sel?.kind === 'music' ? ' on' : '')} style={{ left: 0, width: Math.max(30, total * pps) }}
                  onPointerDown={(e) => { e.stopPropagation(); useEditor.getState().select({ kind: 'music', id: 'music' }) }}>♪ {project.music.name}</div>
              : <span className="muted small" style={{ position: 'absolute', left: 8, top: 8 }}>Sin música</span>}
          </div>

          <div className="edplayhead" style={{ left: playhead * pps }}><i /></div>
        </div>
      </div>
    </div>
  )
}
