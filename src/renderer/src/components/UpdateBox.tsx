import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'

/** Estado de actualizaciones: `compact` para la barra lateral, completo para Configuración. */
export default function UpdateBox({ compact = false }: { compact?: boolean }): React.JSX.Element | null {
  const u = useStore((s) => s.update)
  const go = useStore((s) => s.go)
  const [version, setVersion] = useState('')
  useEffect(() => { void api.version().then(setVersion) }, [])

  if (compact) {
    if (u.status === 'available') return <button className="nav" style={{ color: 'var(--ok)' }} onClick={() => go('config')}><span className="ic">⬆️</span>Actualización {u.version}</button>
    if (u.status === 'downloading') return <div className="nav small muted">Descargando… {u.percent}%</div>
    if (u.status === 'ready') return <button className="nav" style={{ color: 'var(--ok)' }} onClick={() => go('config')}><span className="ic">✅</span>Reiniciar para actualizar</button>
    return null
  }

  return (
    <div className="card col">
      <h2>Actualizaciones</h2>
      <div className="small muted">Versión instalada: <b style={{ color: 'var(--text)' }}>{version}</b></div>
      {u.status === 'unavailable' && <div className="small muted">{u.message}</div>}
      {u.status === 'checking' && <div>Buscando actualizaciones…</div>}
      {u.status === 'none' && <div style={{ color: 'var(--ok)' }}>✔ Tienes la última versión.</div>}
      {u.status === 'error' && <div style={{ color: 'var(--err)' }}>{u.message}</div>}
      {u.status === 'available' && <div className="col">
        <div>Hay una versión nueva: <b>{u.version}</b></div>
        {u.notes && <div className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{u.notes}</div>}
        <div><button className="btn primary" onClick={() => api.updateDownload()}>Descargar actualización</button></div>
      </div>}
      {u.status === 'downloading' && <div><div className="bar"><i style={{ width: `${u.percent}%` }} /></div><div className="small muted">Descargando… {u.percent}%</div></div>}
      {u.status === 'ready' && <div className="col">
        <div style={{ color: 'var(--ok)' }}>✔ La versión {u.version} está lista. Se aplicará al reiniciar (tus proyectos y biblioteca se conservan).</div>
        <div><button className="btn primary" onClick={() => api.updateInstall()}>Reiniciar e instalar ahora</button></div>
      </div>}
      <div><button className="btn" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => api.updateCheck()}>Buscar actualizaciones</button></div>
    </div>
  )
}
