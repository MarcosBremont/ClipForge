import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'

export default function Projects(): React.JSX.Element {
  const { openProject, newDraft, go } = useStore()
  const [list, setList] = useState<Project[]>([])
  const load = useCallback(() => { void api.projects().then(setList) }, [])
  useEffect(load, [load])
  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div><h1>Proyectos</h1><div className="muted">Se guardan automáticamente; ábrelos cuando quieras, incluso después de cerrar la app.</div></div>
        <button className="btn primary" onClick={() => { newDraft(); go('crear') }}>+ Nuevo proyecto</button>
      </div>
      <div className="card">
        {!list.length ? <div className="empty">No hay proyectos todavía.</div> : (
          <table className="t">
            <thead><tr><th>Proyecto</th><th>Duración</th><th>Fragmentos</th><th>Modificado</th><th /></tr></thead>
            <tbody>{list.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b><div className="muted small">{p.text || 'Sin texto'}</div></td>
                <td>{p.settings.duration}s</td><td>{p.plan?.segments.length ?? '–'}</td>
                <td className="muted small">{new Date(p.updatedAt).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }} className="row">
                  <button className="btn sm" onClick={() => openProject(p)}>Abrir</button>
                  <button className="btn sm" onClick={async () => { const n = prompt('Nombre', p.name); if (n) { await api.saveProject({ ...p, name: n }); load() } }}>Renombrar</button>
                  <button className="btn sm danger" onClick={async () => { if (confirm('¿Eliminar este proyecto?')) { await api.deleteProject(p.id); load() } }}>Eliminar</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  )
}
