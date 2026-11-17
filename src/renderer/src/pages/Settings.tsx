import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { api, errMsg } from '../api'
import { useStore } from '../store'
import UpdateBox from '../components/UpdateBox'

export default function Settings(): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const [st, setSt] = useState<AppSettings | null>(null)
  const [enc, setEnc] = useState<string[]>([])
  const load = (): void => { void api.settings().then(setSt) }
  useEffect(() => { load(); void api.hwEncoders().then(setEnc) }, [])
  if (!st) return <div />
  const run = async (fn: () => Promise<void>): Promise<void> => { try { await fn() } catch (e) { notify(errMsg(e), 'err') } }
  return (
    <div style={{ maxWidth: 820 }} className="col">
      <div className="page-head"><div><h1>Configuración</h1></div></div>
      <UpdateBox />
      <div className="card col">
        <h2>Carpeta de salida</h2>
        <div className="row"><input type="text" readOnly value={st.outputDir} /><button className="btn" onClick={() => run(async () => { const d = await api.pickOutputDir(); if (d) { await api.setOutputDir(d); load() } })}>Cambiar…</button></div>
      </div>
      <div className="card col">
        <h2>Rendimiento</h2>
        <label className="ck"><input type="checkbox" checked={st.hwAccel} disabled={!enc.length} onChange={(e) => run(async () => { await api.setHwAccel(e.target.checked); load() })} />
          Usar aceleración por hardware para exportar {enc.length ? <span className="muted small">(detectado: {enc.join(', ')})</span> : <span className="muted small">(no disponible en este equipo; se usa CPU)</span>}</label>
        <div className="small muted">Si el codificador por hardware falla, la app reintenta automáticamente con la CPU (x264).</div>
      </div>
      <div className="card col">
        <h2>Registro de combinaciones</h2>
        <div className="small muted">Cada video generado registra qué fragmentos usó para evitar repetirlos en futuros proyectos. Puedes borrar ese historial para volver a permitir cualquier fragmento.</div>
        <div><button className="btn danger" onClick={() => run(async () => { if (confirm('¿Borrar el historial de fragmentos usados?')) { await api.clearHistory(); notify('Historial borrado') } })}>Borrar historial de fragmentos usados</button></div>
      </div>
    </div>
  )
}
