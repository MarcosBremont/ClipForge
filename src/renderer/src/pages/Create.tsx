import { useEffect, useState } from 'react'
import { DEFAULT_GEN_SETTINGS, type CutSpeed, type GenSettings, type Library, type Plan, type TextStyle, type TextTemplate } from '@shared/types'
import { api, errMsg } from '../api'
import Player from '../components/Player'
import { TextPreview, TextStyleEditor } from '../components/TextStyleEditor'
import { textOverlayPng, watermarkPng } from '../textRender'
import { useStore } from '../store'

const DURATIONS = [10, 15, 20, 30, 45, 60]

export default function Create(): React.JSX.Element {
  const { draft, setDraft, notify, libVersion, go, saveState } = useStore()
  const [libs, setLibs] = useState<Library[]>([])
  const [templates, setTemplates] = useState<TextTemplate[]>([])
  const [hasAI, setHasAI] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phrases, setPhrases] = useState<string[]>([])
  const [styleOpen, setStyleOpen] = useState(false)
  const [tplName, setTplName] = useState('')
  const s = draft.settings

  useEffect(() => {
    void api.libraries().then((l) => {
      setLibs(l)
      const cur = useStore.getState().draft
      if (cur.libraryId === null || !l.some((x) => x.id === cur.libraryId)) { if (l[0]) setDraft({ libraryId: l[0].id }) }
    })
    void api.templates().then(setTemplates)
    void api.providers().then((p) => setHasAI(p.some((x) => x.enabled && x.hasKey)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libVersion])

  const lib = libs.find((l) => l.id === draft.libraryId) ?? null
  const usable = lib ? lib.videoCount - lib.duplicateCount : 0
  const setS = (p: Partial<GenSettings>): void => setDraft({ settings: { ...s, ...p } })
  const setStyle = (p: Partial<TextStyle>): void => setDraft({ style: { ...draft.style, ...p } })
  const guard = async (fn: () => Promise<void>): Promise<void> => { setBusy(true); try { await fn() } catch (e) { notify(errMsg(e), 'err') } finally { setBusy(false) } }

  const needReady = (): boolean => {
    if (draft.libraryId === null || !usable) { notify('Selecciona una biblioteca con videos (Biblioteca de videos → importar).', 'err'); return false }
    if (!draft.text.trim()) { notify('Escribe el texto que quieres que aparezca en el video.', 'err'); return false }
    return true
  }

  const preview = (): Promise<void> => guard(async () => {
    if (!needReady()) return
    const plan = await api.planMake(draft.libraryId!, s)
    setDraft({ plan })
  })
  const regen = (): Promise<void> => guard(async () => {
    if (!needReady()) return
    setDraft({ plan: await api.planRegen(draft.libraryId!, s, draft.plan) })
  })
  const exportVideos = (usePlan: boolean): Promise<void> => guard(async () => {
    if (!needReady()) return
    const [textPng, wm] = await Promise.all([textOverlayPng(draft.text, draft.style), watermarkPng(s.watermark)])
    await api.render({ projectId: draft.projectId, libraryId: draft.libraryId!, text: draft.text, style: draft.style, settings: s, textPng, watermarkPng: wm, plan: usePlan ? draft.plan : null })
    notify(s.versions > 1 ? `Generando ${s.versions} versiones…` : 'Generando video…')
  })

  const manual = !s.auto

  return (
    <div>
      <div className="page-head">
        <div><h1>Crear video</h1><div className="muted">Elige recursos, escribe el texto y genera. Todo el proceso es local. · <span>{saveState === 'saving' ? 'Guardando…' : saveState === 'saved' ? '✔ Guardado automáticamente' : ''}</span></div></div>
        <input type="text" style={{ width: 240 }} value={draft.name} onChange={(e) => setDraft({ name: e.target.value })} placeholder="Nombre del proyecto" />
      </div>
      <div className="studio">
        <div className="col">
          <div className="card col">
            <h2>1 · Recursos</h2>
            {!libs.length ? <div>Aún no tienes biblioteca. <button className="btn sm primary" onClick={() => go('biblioteca')}>Importar videos</button></div> : (
              <select value={draft.libraryId ?? ''} onChange={(e) => setDraft({ libraryId: Number(e.target.value), plan: null })}>
                {libs.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.videoCount - l.duplicateCount} videos utilizables</option>)}
              </select>
            )}
            {lib && !usable && <div className="small" style={{ color: 'var(--err)' }}>Esta biblioteca no tiene videos utilizables.</div>}
          </div>

          <div className="card col">
            <h2>2 · ¿Qué texto quieres que aparezca en tu video?</h2>
            <textarea value={draft.text} placeholder="¿Será que soy un mal hombre?" onChange={(e) => setDraft({ text: e.target.value })} />
            <div className="row wrap">
              <button className="btn sm" disabled={!hasAI || busy} title={hasAI ? '' : 'Opcional: activa un proveedor de IA en "Inteligencia artificial"'} onClick={() => guard(async () => setPhrases(await api.suggest(draft.text)))}>💡 Sugerir frases con IA</button>
              {!hasAI && <span className="small muted">(opcional · sin IA todo funciona igual)</span>}
            </div>
            {phrases.length > 0 && <div className="chips">{phrases.map((p) => <span key={p} className="chip" onClick={() => setDraft({ text: p })}>{p}</span>)}</div>}
          </div>

          <div className="card col">
            <h2>3 · Configuración</h2>
            <label className="ck"><input type="checkbox" checked={s.auto} onChange={(e) => setS({ auto: e.target.checked })} /><b>Automático</b> <span className="muted">— la app decide fragmentos y ritmo según la duración</span></label>
            <div><div className="small muted" style={{ marginBottom: 4 }}>Duración total</div>
              <div className="chips">{DURATIONS.map((d) => <span key={d} className={'chip' + (s.duration === d ? ' on' : '')} onClick={() => setS({ duration: d })}>{d} s</span>)}</div></div>
            <div className="grid g3" style={{ opacity: manual ? 1 : 0.45 }}>
              <label className="f"><span>Cantidad de fragmentos</span><input type="number" min={2} max={120} disabled={!manual} placeholder="auto" value={s.segmentCount ?? ''} onChange={(e) => setS({ segmentCount: e.target.value ? Number(e.target.value) : null, segmentLength: null })} /></label>
              <label className="f"><span>Duración aprox. de cada uno (s)</span><input type="number" min={0.4} max={15} step={0.1} disabled={!manual} placeholder="auto" value={s.segmentLength ?? ''} onChange={(e) => setS({ segmentLength: e.target.value ? Number(e.target.value) : null, segmentCount: null })} /></label>
              <div><div className="small muted" style={{ marginBottom: 4 }}>Velocidad de cortes</div>
                <div className="chips">{(['lento', 'normal', 'rapido'] as CutSpeed[]).map((v) => <span key={v} className={'chip' + (s.speed === v ? ' on' : '')} style={manual ? undefined : { pointerEvents: 'none' }} onClick={() => setS({ speed: v, segmentCount: null, segmentLength: null })}>{v === 'rapido' ? 'Rápido' : v === 'lento' ? 'Lento' : 'Normal'}</span>)}</div></div>
            </div>
            <div className="grid g3">
              <div><div className="small muted" style={{ marginBottom: 4 }}>FPS</div><div className="chips">{([30, 60] as const).map((f) => <span key={f} className={'chip' + (s.fps === f ? ' on' : '')} onClick={() => setS({ fps: f })}>{f}</span>)}</div></div>
              <label className="f"><span>Calidad</span><select value={s.quality} onChange={(e) => setS({ quality: e.target.value as GenSettings['quality'] })}><option value="alta">Alta (más lento)</option><option value="media">Media</option><option value="rapida">Rápida (menor calidad)</option></select></label>
              <label className="f"><span>Versiones a generar</span><input type="number" min={1} max={100} value={s.versions} onChange={(e) => setS({ versions: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} /></label>
            </div>
            <div className="grid g2">
              <label className="ck"><input type="checkbox" checked={s.originalAudio} onChange={(e) => setS({ originalAudio: e.target.checked })} />Conservar audio original</label>
              <label className="ck"><input type="checkbox" checked={s.useAI} disabled={!hasAI} onChange={(e) => setS({ useAI: e.target.checked })} />Priorizar fragmentos valorados por IA {!hasAI && <span className="muted small">(no configurada)</span>}</label>
            </div>
            <div className="row wrap">
              <button className="btn sm" onClick={() => guard(async () => { const p = await api.pickMusic(); if (p) setS({ musicPath: p }) })}>🎵 {s.musicPath ? 'Cambiar música' : 'Música de fondo (opcional)'}</button>
              {s.musicPath && <><span className="small muted">{s.musicPath.split(/[\\/]/).pop()}</span>
                <input type="range" min={0} max={1} step={0.05} value={s.musicVolume} style={{ width: 110 }} onChange={(e) => setS({ musicVolume: Number(e.target.value) })} />
                <button className="btn sm danger" onClick={() => setS({ musicPath: null })}>Quitar</button></>}
            </div>
            <label className="f"><span>Mi marca de agua / usuario (opcional, ej. @miusuario)</span><input type="text" value={s.watermark} onChange={(e) => setS({ watermark: e.target.value })} /></label>
            <div className="small muted">Formato fijo: vertical 9:16 · 1080×1920 · H.264 + AAC · MP4</div>
            <button className="btn sm" onClick={() => setS({ ...DEFAULT_GEN_SETTINGS, musicPath: s.musicPath })}>Restablecer ajustes</button>
          </div>

          <div className="card col">
            <div className="row sp"><h2 style={{ margin: 0 }}>4 · Estilo del texto</h2><button className="btn sm" onClick={() => setStyleOpen((v) => !v)}>{styleOpen ? 'Ocultar' : 'Personalizar'}</button></div>
            {templates.length > 0 && <div className="chips">{templates.map((t) => <span key={t.id} className="chip" onClick={() => setDraft({ style: t.style })}>{t.name}</span>)}</div>}
            {styleOpen && <>
              <TextStyleEditor style={draft.style} onChange={setStyle} />
              <div className="row"><input type="text" placeholder="Nombre de la plantilla" value={tplName} onChange={(e) => setTplName(e.target.value)} />
                <button className="btn" disabled={!tplName.trim()} onClick={() => guard(async () => { await api.saveTemplate(tplName.trim(), draft.style); setTplName(''); setTemplates(await api.templates()); notify('Plantilla guardada') })}>Guardar plantilla</button></div>
            </>}
          </div>
        </div>

        <div className="col" style={{ position: 'sticky', top: 0 }}>
          {draft.plan && draft.libraryId !== null
            ? <Player plan={draft.plan} libraryId={draft.libraryId} text={draft.text} style={draft.style} settings={s} onPlan={(p: Plan) => setDraft({ plan: p })} />
            : <TextPreview text={draft.text} style={draft.style} />}
          <div className="col">
            {draft.plan
              ? <button className="btn" disabled={busy} onClick={regen}>🔀 Volver a generar selección</button>
              : <button className="btn" disabled={busy} onClick={preview}>👁 Generar y previsualizar</button>}
            <button className="btn primary" disabled={busy} onClick={() => exportVideos(true)}>🎬 {draft.plan ? 'Exportar este video' : 'Generar video'}{s.versions > 1 ? ` (+${s.versions - 1} versiones)` : ''}</button>
            {s.versions > 1 && draft.plan && <button className="btn" disabled={busy} onClick={() => exportVideos(false)}>Exportar {s.versions} versiones nuevas</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
