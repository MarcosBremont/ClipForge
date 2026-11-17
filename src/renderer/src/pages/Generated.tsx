import { useCallback, useEffect, useState } from 'react'
import { api, fmtSize, mediaUrl, type OutputRow } from '../api'
import { useStore } from '../store'

export default function Generated(): React.JSX.Element {
  const libVersion = useStore((s) => s.libVersion)
  const [list, setList] = useState<OutputRow[]>([])
  const [play, setPlay] = useState<OutputRow | null>(null)
  const load = useCallback(() => { void api.outputs().then(setList) }, [])
  useEffect(load, [load, libVersion])
  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="page-head"><div><h1>Videos generados</h1><div className="muted">Listos para publicar en TikTok, Reels o Shorts.</div></div></div>
      <div className="card">
        {!list.length ? <div className="empty">Todavía no has generado videos.</div> : (
          <table className="t">
            <thead><tr><th>Texto</th><th>Duración</th><th>Tamaño</th><th>Fecha</th><th /></tr></thead>
            <tbody>{list.map((o) => (
              <tr key={o.id}>
                <td><b>{o.text}</b><div className="muted small" style={{ userSelect: 'text' }}>{o.path}{!o.exists && ' · (archivo no encontrado)'}</div></td>
                <td>{o.duration.toFixed(0)}s</td><td>{fmtSize(o.size)}</td><td className="muted small">{new Date(o.createdAt).toLocaleString()}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn sm primary" disabled={!o.exists} onClick={() => setPlay(o)}>▶ Ver</button>
                  <button className="btn sm" disabled={!o.exists} onClick={() => api.reveal(o.path)}>Mostrar carpeta</button>
                  <button className="btn sm danger" onClick={async () => { if (confirm('¿Borrar también el archivo de video?\nAceptar = borrar archivo · Cancelar = solo quitar de la lista')) await api.deleteOutput(o.id, true); else await api.deleteOutput(o.id, false); load() }}>Quitar</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {play && (
        <div className="modal-bg" onClick={() => setPlay(null)}>
          <div className="modal" style={{ width: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <video src={mediaUrl(play.path)} controls autoPlay style={{ maxHeight: '75vh', maxWidth: '80vw', borderRadius: 10 }} />
            <div className="row sp" style={{ marginTop: 10 }}><span className="muted small">{play.text}</span><button className="btn" onClick={() => setPlay(null)}>Cerrar</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
