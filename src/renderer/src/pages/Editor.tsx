import { useCallback, useEffect, useRef, useState } from 'react'
import type { Library, VideoAsset } from '@shared/types'
import * as E from '@shared/editor'
import { api, errMsg, fmtTime, mediaUrl, type EditorRow } from '../api'
import { useEditor } from '../editorStore'
import { useStore } from '../store'
import { textOverlayPng } from '../textRender'
import { TextStyleEditor } from '../components/TextStyleEditor'
import EditorPreview from '../components/EditorPreview'
import EditorTimeline from '../components/EditorTimeline'

function MediaBin(): React.JSX.Element {
  const libVersion = useStore((s) => s.libVersion)
  const [libs, setLibs] = useState<Library[]>([])
  const [libId, setLibId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [items, setItems] = useState<VideoAsset[]>([])
  const addVideo = useEditor((s) => s.addVideo)
  useEffect(() => { void api.libraries().then((l) => { setLibs(l); setLibId((cur) => cur ?? l[0]?.id ?? null) }) }, [libVersion])
  useEffect(() => {
    if (libId === null) { setItems([]); return }
    void api.videos(libId, { search: q, limit: 120 }).then((r) => setItems(r.items.filter((v) => !v.dupOf && !v.missing)))
  }, [libId, q, libVersion])
  return (
    <div className="col" style={{ minHeight: 0, height: '100%' }}>
      <b>Videos</b>
      {libs.length > 1 && <select value={libId ?? ''} onChange={(e) => setLibId(Number(e.target.value))}>{libs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.videoCount})</option>)}</select>}
      <input type="text" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="edbin">
        {items.map((v) => (
          <div className="edthumb" key={v.id} title={`${v.name}\nClic: agregar al final · Doble clic: agregar en la cabeza de reproducción`}
            onClick={() => addVideo(v)} onDoubleClick={() => addVideo(v, true)}>
            <div className="th" style={v.thumb ? { backgroundImage: `url("${mediaUrl(v.thumb)}")` } : undefined} />
            <span className="dur">{v.duration.toFixed(1)}s</span>
            <div className="nm">{v.name}</div>
          </div>
        ))}
        {!items.length && <div className="muted small">{libs.length ? 'No hay videos en esta biblioteca.' : 'Importa videos en «Biblioteca de videos» para usarlos aquí.'}</div>}
      </div>
    </div>
  )
}

function Inspector(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const sel = useEditor((s) => s.sel)
  const videos = useEditor((s) => s.videos)
  const playhead = useEditor((s) => s.playhead)
  const { apply, live, seek, select } = useEditor.getState()
  const last = useRef({ key: '', t: 0 })
  // Varios cambios seguidos del mismo control (arrastrar un deslizador) cuentan como un solo paso para deshacer.
  const edit = (key: string, fn: (p: E.EditorProject) => E.EditorProject): void => {
    const now = Date.now()
    if (last.current.key === key && now - last.current.t < 700) live(fn); else apply(fn)
    last.current = { key, t: now }
  }

  const clip = sel?.kind === 'clip' ? project.clips.find((c) => c.id === sel.id) : undefined
  const text = sel?.kind === 'text' ? project.texts.find((t) => t.id === sel.id) : undefined

  if (clip) {
    const v = videos[clip.videoId]
    const start = E.clipStarts(project)[project.clips.indexOf(clip)]
    return (
      <div className="col">
        <h3>Clip</h3>
        <div className="small muted">{v?.name ?? 'video'} · {fmtTime(clip.srcStart)} → {fmtTime(clip.srcEnd)} del original<br />Dura {E.clipDur(clip).toFixed(2)} s en la línea de tiempo</div>
        <label className="f"><span>Velocidad: <b>{clip.speed}×</b></span></label>
        <div className="chips">{E.SPEEDS.map((s) => <span key={s} className={'chip' + (clip.speed === s ? ' on' : '')} onClick={() => apply((p) => E.setClip(p, clip.id, { speed: s }))}>{s}×</span>)}</div>
        <label className="f"><span>Volumen: <b>{Math.round(clip.volume * 100)}%</b></span>
          <input type="range" min={0} max={1} step={0.01} value={clip.volume} onChange={(e) => edit('vol' + clip.id, (p) => E.setClip(p, clip.id, { volume: Number(e.target.value) }))} /></label>
        <div className="row wrap">
          <button className="btn sm" onClick={() => apply((p) => E.setClip(p, clip.id, { volume: clip.volume > 0 ? 0 : 1 }))}>{clip.volume > 0 ? '🔇 Silenciar' : '🔊 Activar sonido'}</button>
          <button className="btn sm" onClick={() => seek(start)}>⏮ Ir al inicio</button>
        </div>
        <div className="row wrap">
          <button className="btn sm" onClick={() => { const r = E.splitAt(project, playhead); if (r) { apply(() => r.project); select({ kind: 'clip', id: r.selectId }) } }}>✂ Dividir aquí</button>
          <button className="btn sm" onClick={() => { const r = E.duplicateClip(project, clip.id); if (r) { apply(() => r.project); select({ kind: 'clip', id: r.selectId }) } }}>⧉ Duplicar</button>
          <button className="btn sm danger" onClick={() => apply((p) => E.removeClip(p, clip.id))}>🗑 Eliminar</button>
        </div>
        <div className="muted small">Arrastra los bordes del clip en la línea de tiempo para recortar, y el centro para cambiar su orden.</div>
      </div>
    )
  }

  if (text) {
    return (
      <div className="col">
        <h3>Texto</h3>
        <textarea value={text.text} placeholder="Escribe el texto…" onChange={(e) => edit('txt' + text.id, (p) => E.setText(p, text.id, { text: e.target.value }))} />
        <div className="grid g2">
          <label className="f"><span>Aparece en (s)</span><input type="number" min={0} step={0.1} value={Math.round(text.start * 100) / 100} onChange={(e) => edit('ts' + text.id, (p) => E.moveText(p, text.id, Number(e.target.value)))} /></label>
          <label className="f"><span>Dura (s)</span><input type="number" min={0.3} step={0.1} value={Math.round(text.duration * 100) / 100} onChange={(e) => edit('td' + text.id, (p) => E.resizeText(p, text.id, 'end', text.start + Number(e.target.value)))} /></label>
        </div>
        <div className="row wrap">
          <button className="btn sm" onClick={() => seek(text.start)}>⏮ Ir al inicio</button>
          <button className="btn sm" onClick={() => { const r = E.duplicateText(project, text.id); if (r) { apply(() => r.project); select({ kind: 'text', id: r.selectId }) } }}>⧉ Duplicar</button>
          <button className="btn sm danger" onClick={() => apply((p) => E.removeText(p, text.id))}>🗑 Eliminar</button>
        </div>
        <div className="muted small">Arrastra el texto en la vista previa para moverlo. Se pega al centro cuando lo acercas.</div>
        <TextStyleEditor hideTiming style={text.style} onChange={(patch) => edit('sty' + text.id + Object.keys(patch).join(), (p) => E.setText(p, text.id, { style: patch }))} />
      </div>
    )
  }

  if (sel?.kind === 'music' && project.music) {
    const m = project.music
    return (
      <div className="col">
        <h3>Música</h3>
        <div className="small muted">{m.name}<br />Se repite si es más corta que el video y se recorta al final.</div>
        <label className="f"><span>Volumen: <b>{Math.round(m.volume * 100)}%</b></span>
          <input type="range" min={0} max={1} step={0.01} value={m.volume} onChange={(e) => edit('mus', (p) => ({ ...p, music: p.music ? { ...p.music, volume: Number(e.target.value) } : null }))} /></label>
        <button className="btn sm danger" onClick={() => { apply((p) => ({ ...p, music: null })); select(null) }}>🗑 Quitar música</button>
      </div>
    )
  }

  return (
    <div className="col">
      <h3>Proyecto</h3>
      <div className="small muted">Duración: <b>{E.totalDuration(project).toFixed(1)} s</b> · {project.clips.length} clips · {project.texts.length} textos</div>
      <div className="card small" style={{ lineHeight: 1.7 }}>
        <b>Atajos</b><br />
        <kbd>Espacio</kbd> reproducir · <kbd>S</kbd> dividir<br />
        <kbd>Supr</kbd> eliminar · <kbd>Ctrl+D</kbd> duplicar<br />
        <kbd>T</kbd> agregar texto · <kbd>←</kbd><kbd>→</kbd> fotograma<br />
        <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> deshacer / rehacer<br />
        <kbd>Ctrl</kbd> + rueda: zoom de la línea de tiempo
      </div>
      <div className="muted small">Selecciona un clip, un texto o la música para editarlo aquí.</div>
    </div>
  )
}

let autoLoaded = false // solo la primera vez que se abre el editor tras iniciar la app

export default function Editor(): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const project = useEditor((s) => s.project)
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const pps = useEditor((s) => s.pps)
  const sel = useEditor((s) => s.sel)
  const saveState = useEditor((s) => s.saveState)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const [projects, setProjects] = useState<EditorRow[] | null>(null)
  const [exporting, setExporting] = useState(false)
  const total = E.totalDuration(project)

  const split = useCallback((): void => {
    const st = useEditor.getState()
    const r = E.splitAt(st.project, st.playhead)
    if (!r) { notify('No se puede dividir aquí: acércate al centro de un clip (mínimo 0,3 s a cada lado).', 'err'); return }
    st.apply(() => r.project); st.select({ kind: 'clip', id: r.selectId })
  }, [notify])

  const remove = useCallback((): void => {
    const st = useEditor.getState()
    if (st.sel?.kind === 'clip') st.apply((p) => E.removeClip(p, st.sel!.id))
    else if (st.sel?.kind === 'text') st.apply((p) => E.removeText(p, st.sel!.id))
    else if (st.sel?.kind === 'music') st.apply((p) => ({ ...p, music: null }))
  }, [])

  const addText = useCallback((): void => {
    const st = useEditor.getState()
    if (!st.project.clips.length) { notify('Primero agrega un video a la línea de tiempo.', 'err'); return }
    const last = st.project.texts[st.project.texts.length - 1]
    const r = E.addText(st.project, st.playhead, 'Tu texto', last ? { ...last.style, y: 0.5 } : undefined)
    st.apply(() => r.project); st.select({ kind: 'text', id: r.selectId })
  }, [notify])

  const duplicate = useCallback((): void => {
    const st = useEditor.getState()
    if (st.sel?.kind === 'clip') { const r = E.duplicateClip(st.project, st.sel.id); if (r) { st.apply(() => r.project); st.select({ kind: 'clip', id: r.selectId }) } }
    else if (st.sel?.kind === 'text') { const r = E.duplicateText(st.project, st.sel.id); if (r) { st.apply(() => r.project); st.select({ kind: 'text', id: r.selectId }) } }
  }, [])

  const pickMusic = async (): Promise<void> => {
    const path = await api.pickMusic()
    if (!path) return
    const name = path.split(/[\\/]/).pop() ?? 'música'
    useEditor.getState().apply((p) => ({ ...p, music: { path, name, volume: 0.8 } }))
    useEditor.getState().select({ kind: 'music', id: 'music' })
  }

  // Atajos de teclado (no se activan escribiendo en un campo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const st = useEditor.getState()
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (k === ' ') { e.preventDefault(); st.setPlaying(!st.playing) }
      else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? st.redo() : st.undo() }
      else if (mod && k === 'y') { e.preventDefault(); st.redo() }
      else if (mod && k === 'd') { e.preventDefault(); duplicate() }
      else if (k === 's' && !mod) { e.preventDefault(); split() }
      else if (k === 't' && !mod) { e.preventDefault(); addText() }
      else if (k === 'delete' || k === 'backspace') { e.preventDefault(); remove() }
      else if (k === 'arrowleft') { e.preventDefault(); st.setPlaying(false); st.seek(st.playhead - (e.shiftKey ? 1 : 1 / 30)) }
      else if (k === 'arrowright') { e.preventDefault(); st.setPlaying(false); st.seek(st.playhead + (e.shiftKey ? 1 : 1 / 30)) }
      else if (k === 'home') { e.preventDefault(); st.seek(0) }
      else if (k === 'end') { e.preventDefault(); st.seek(E.totalDuration(st.project)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [split, remove, addText, duplicate])

  // Primera visita tras iniciar la app: reabre el último proyecto del editor (si el actual está vacío).
  useEffect(() => {
    if (autoLoaded) return
    autoLoaded = true
    const st = useEditor.getState()
    if (st.project.clips.length || st.project.id !== null) return
    void api.editorList().then((l) => { if (l[0] && !useEditor.getState().project.clips.length && useEditor.getState().project.id === null) useEditor.getState().open(l[0]) })
  }, [])

  // Al salir de la página se detiene la reproducción
  useEffect(() => () => useEditor.getState().setPlaying(false), [])

  const doExport = async (): Promise<void> => {
    const p = useEditor.getState().project
    if (!p.clips.length) { notify('La línea de tiempo está vacía.', 'err'); return }
    setExporting(true)
    try {
      const texts = (await Promise.all(p.texts.map(async (t) => ({ png: await textOverlayPng(t.text, t.style), start: t.start, end: t.start + t.duration }))))
        .filter((t): t is { png: Uint8Array; start: number; end: number } => !!t.png)
      await api.editorExport({
        name: p.name || 'editor', fps: p.fps, quality: p.quality, texts,
        clips: p.clips.map((c) => ({ videoId: c.videoId, srcStart: c.srcStart, srcEnd: c.srcEnd, speed: c.speed, volume: c.volume })),
        music: p.music ? { path: p.music.path, volume: p.music.volume } : null
      })
      notify('Exportando… el progreso aparece abajo a la derecha. El video quedará en «Videos generados».')
    } catch (e) { notify(errMsg(e), 'err') } finally { setExporting(false) }
  }

  const openProjects = async (): Promise<void> => setProjects(await api.editorList())

  return (
    <div className="editor">
      <div className="edhead">
        <input type="text" value={project.name} onChange={(e) => useEditor.setState((s) => ({ project: { ...s.project, name: e.target.value } }))} style={{ maxWidth: 260 }} />
        <button className="btn sm" onClick={() => void openProjects()}>📁 Proyectos</button>
        <button className="btn sm" onClick={() => useEditor.getState().newProject()}>＋ Nuevo</button>
        <span className="small muted">{saveState === 'saving' ? 'Guardando…' : saveState === 'saved' ? '✔ Guardado' : ''}</span>
        <div className="grow" />
        <select value={project.fps} onChange={(e) => useEditor.getState().apply((p) => ({ ...p, fps: Number(e.target.value) as 30 | 60 }))} style={{ width: 90 }}><option value={30}>30 fps</option><option value={60}>60 fps</option></select>
        <select value={project.quality} onChange={(e) => useEditor.getState().apply((p) => ({ ...p, quality: e.target.value as E.EditorProject['quality'] }))} style={{ width: 120 }}><option value="alta">Alta</option><option value="media">Media</option><option value="rapida">Rápida</option></select>
        <button className="btn primary" disabled={exporting || !project.clips.length} onClick={() => void doExport()}>⬇ Exportar</button>
      </div>

      <aside className="edleft card">
        <MediaBin />
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={addText}>＋ Texto (T)</button>
          <button className="btn sm" onClick={() => void pickMusic()}>♪ Música</button>
        </div>
      </aside>

      <section className="edcenter"><div className="edstage"><EditorPreview /></div></section>

      <aside className="edright card"><Inspector /></aside>

      <div className="edbar">
        <button className="btn sm" title="Al inicio (Inicio)" onClick={() => useEditor.getState().seek(0)}>⏮</button>
        <button className="btn sm primary" style={{ width: 44 }} title="Reproducir / pausar (Espacio)" onClick={() => useEditor.getState().setPlaying(!playing)}>{playing ? '⏸' : '▶'}</button>
        <span className="edtime">{fmtTime(playhead)} / {fmtTime(total)}</span>
        <span className="edsep" />
        <button className="btn sm" title="Dividir en la cabeza de reproducción (S)" disabled={!project.clips.length} onClick={split}>✂ Dividir</button>
        <button className="btn sm" title="Duplicar (Ctrl+D)" disabled={!sel || sel.kind === 'music'} onClick={duplicate}>⧉</button>
        <button className="btn sm danger" title="Eliminar (Supr)" disabled={!sel} onClick={remove}>🗑</button>
        <span className="edsep" />
        <button className="btn sm" title="Deshacer (Ctrl+Z)" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>↶</button>
        <button className="btn sm" title="Rehacer (Ctrl+Y)" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>↷</button>
        <div className="grow" />
        <span className="small muted">Zoom</span>
        <input type="range" min={12} max={300} value={pps} onChange={(e) => useEditor.getState().setZoom(Number(e.target.value))} style={{ width: 130 }} />
      </div>

      <div className="edbottom"><EditorTimeline /></div>

      {projects && (
        <div className="modal-bg" onClick={() => setProjects(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row sp" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Proyectos del editor</h2><button className="btn" onClick={() => setProjects(null)}>Cerrar</button></div>
            {!projects.length && <div className="muted">Aún no hay proyectos guardados.</div>}
            {projects.map((r) => {
              let n = 0
              try { n = (JSON.parse(r.data) as E.EditorProject).clips.length } catch { /* dañado */ }
              return (
                <div className="row sp card" key={r.id} style={{ marginBottom: 8 }}>
                  <div><b>{r.name}</b><div className="small muted">{n} clips · {new Date(r.updatedAt).toLocaleString()}</div></div>
                  <div className="row">
                    <button className="btn sm primary" onClick={() => { useEditor.getState().open(r); setProjects(null) }}>Abrir</button>
                    <button className="btn sm danger" onClick={async () => { await api.editorDelete(r.id); setProjects(await api.editorList()) }}>Borrar</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
