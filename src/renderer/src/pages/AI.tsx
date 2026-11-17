import { useCallback, useEffect, useState } from 'react'
import type { AIProviderInfo, Library } from '@shared/types'
import { api, errMsg } from '../api'
import { useStore } from '../store'

function Provider({ p, reload }: { p: AIProviderInfo; reload: () => void }): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const [key, setKey] = useState('')
  const [model, setModel] = useState(p.model)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>): Promise<void> => { setBusy(true); try { await fn() } catch (e) { notify(errMsg(e), 'err') } finally { setBusy(false) } }
  return (
    <div className="card col">
      <div className="row sp"><h2 style={{ margin: 0 }}>{p.label}</h2>
        <div className="row">{p.hasKey && <span className="pill ok">Clave guardada</span>}{p.enabled && <span className="pill ok">Activo</span>}</div></div>
      <label className="f"><span>API key {p.hasKey && '(deja en blanco para conservar la actual)'}</span>
        <input type="password" autoComplete="off" placeholder={p.hasKey ? '••••••••••••' : 'Pega tu clave'} value={key} onChange={(e) => setKey(e.target.value)} /></label>
      <label className="f"><span>Modelo</span><input type="text" value={model} onChange={(e) => setModel(e.target.value)} /></label>
      <div className="row wrap">
        <button className="btn" disabled={busy} onClick={() => run(async () => { if (key) await api.setKey(p.id, key); await api.setModel(p.id, model); setKey(''); reload(); notify('Guardado') })}>Guardar</button>
        <button className="btn" disabled={busy || (!p.hasKey && !key)} onClick={() => run(async () => { if (key) { await api.setKey(p.id, key); setKey('') } await api.setModel(p.id, model); reload(); const r = await api.testProvider(p.id); notify(`✔ Conexión correcta: "${r}"`) })}>Probar conexión</button>
        <button className={'btn' + (p.enabled ? '' : ' primary')} disabled={busy || !p.hasKey} onClick={() => run(async () => { await api.setActive(p.enabled ? null : p.id); reload() })}>{p.enabled ? 'Desactivar' : 'Usar este proveedor'}</button>
        {p.hasKey && <button className="btn danger" disabled={busy} onClick={() => run(async () => { await api.setKey(p.id, ''); if (p.enabled) await api.setActive(null); reload() })}>Borrar clave</button>}
      </div>
    </div>
  )
}

export default function AI(): React.JSX.Element {
  const { notify } = useStore()
  const [provs, setProvs] = useState<AIProviderInfo[]>([])
  const [libs, setLibs] = useState<Library[]>([])
  const [lib, setLib] = useState<number | null>(null)
  const [limit, setLimit] = useState(40)
  const load = useCallback(() => { void api.providers().then(setProvs); void api.libraries().then((l) => { setLibs(l); setLib((c) => c ?? l[0]?.id ?? null) }) }, [])
  useEffect(load, [load])
  const active = provs.find((p) => p.enabled)
  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head"><div><h1>Inteligencia artificial</h1>
        <div className="muted">Totalmente opcional. La selección, el corte, el montaje y la exportación se hacen siempre en tu equipo, sin IA ni internet.</div></div></div>
      <div className="card col" style={{ marginBottom: 14 }}>
        <h2>Qué puede hacer la IA</h2>
        <div className="small muted">• Sugerir frases y preguntas para tus videos. • Valorar el atractivo visual de tus videos (se envía a la IA <b>solo una pequeña hoja de 4 miniaturas por video</b>, nunca el archivo completo) para priorizar los mejores fragmentos y evitar escenas aburridas o repetitivas.</div>
        <div className="row wrap">
          <select style={{ width: 240 }} value={lib ?? ''} onChange={(e) => setLib(Number(e.target.value))}>{libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <label className="f" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>Máx. videos por análisis <input type="number" min={1} max={500} style={{ width: 80 }} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
          <button className="btn primary" disabled={!active || lib === null} title={active ? '' : 'Activa un proveedor primero'} onClick={async () => { try { await api.analyzeAI(lib!, limit) } catch (e) { notify(errMsg(e), 'err') } }}>Analizar videos con {active?.label ?? 'IA'}</button>
        </div>
        <div className="small muted">Las puntuaciones se guardan; en "Crear video" activa "Priorizar fragmentos valorados por IA". Las solicitudes a la API pueden tener coste según tu proveedor.</div>
      </div>
      <div className="grid g2">{provs.map((p) => <Provider key={p.id + p.model + p.hasKey + p.enabled} p={p} reload={load} />)}</div>
      <div className="small muted" style={{ marginTop: 12 }}>Las claves se cifran con el almacén seguro del sistema (Windows DPAPI / macOS Keychain) y nunca se incluyen en el código ni salen de tu equipo, salvo hacia el proveedor que elijas.</div>
    </div>
  )
}
