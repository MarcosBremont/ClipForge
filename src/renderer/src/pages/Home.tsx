import { useEffect, useState } from 'react'
import type { DashboardStats } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'

export default function Home(): React.JSX.Element {
  const { go, newDraft, openProject, libVersion } = useStore()
  const [st, setSt] = useState<DashboardStats | null>(null)
  useEffect(() => { void api.stats().then(setSt) }, [libVersion])

  const start = (): void => {
    if (!st?.videos) { useStore.getState().notify('Primero importa videos en la Biblioteca', 'err'); go('biblioteca'); return }
    newDraft(); go('crear')
  }

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head"><div><h1>Inicio</h1><div className="muted">Tu carpeta de videos, una frase y un clic.</div></div></div>
      <button className="hero" onClick={start}>CREAR VIDEO AUTOMÁTICAMENTE</button>
      <div className="grid g3" style={{ margin: '18px 0' }}>
        <div className="card"><div className="stat">{st?.videos ?? '–'}</div><div className="stat-l">Videos importados</div></div>
        <div className="card"><div className="stat">{st?.libraries ?? '–'}</div><div className="stat-l">Bibliotecas</div></div>
        <div className="card"><div className="stat">{st?.generated ?? '–'}</div><div className="stat-l">Videos generados</div></div>
      </div>
      <div className="card">
        <h2>Proyectos recientes</h2>
        {!st?.recentProjects.length ? <div className="empty">Aún no hay proyectos. Se guardan solos mientras trabajas.</div> : (
          <table className="t"><tbody>
            {st.recentProjects.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b><div className="muted small">{p.text || 'Sin texto'}</div></td>
                <td className="muted small">{new Date(p.updatedAt).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => openProject(p)}>Abrir</button></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
    </div>
  )
}
