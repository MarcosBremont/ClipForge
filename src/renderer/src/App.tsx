import { useEffect } from 'react'
import { api } from './api'
import { initJobListener, initUpdateListener, useStore, type Page } from './store'
import UpdateBox from './components/UpdateBox'
import Home from './pages/Home'
import Library from './pages/Library'
import Create from './pages/Create'
import Editor from './pages/Editor'
import Projects from './pages/Projects'
import Generated from './pages/Generated'
import Templates from './pages/Templates'
import AI from './pages/AI'
import Settings from './pages/Settings'

const NAV: Array<[Page, string, string]> = [
  ['inicio', '🏠', 'Inicio'], ['biblioteca', '🎞️', 'Biblioteca de videos'], ['crear', '✨', 'Crear video'], ['editor', '✂️', 'Editor de video'], ['proyectos', '📁', 'Proyectos'],
  ['generados', '🎬', 'Videos generados'], ['plantillas', '🔤', 'Plantillas de texto'], ['ia', '🤖', 'Inteligencia artificial'], ['config', '⚙️', 'Configuración']
]

function JobBar(): React.JSX.Element {
  const jobs = useStore((s) => s.jobs)
  const dismiss = useStore((s) => s.dismissJob)
  const list = Object.values(jobs).filter((j) => !(j.status === 'done' && (j.result as { subJob?: string } | undefined)?.subJob))
  if (!list.length) return <></>
  return (
    <div className="jobbar">
      {list.map((j) => {
        const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : 0
        const running = j.status === 'running'
        return (
          <div className="job" key={j.jobId}>
            <div className="row sp">
              <b>{j.label}</b>
              {running ? <button className="btn sm danger" onClick={() => api.cancelJob(j.jobId)}>Cancelar</button> : <button className="btn sm" onClick={() => dismiss(j.jobId)}>Cerrar</button>}
            </div>
            <div className="bar"><i style={{ width: `${running && !j.total ? 5 : pct}%`, background: j.status === 'error' ? 'var(--err)' : undefined }} /></div>
            <div className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 70, overflow: 'hidden' }}>
              {running ? (j.kind === 'render' ? `${j.message ?? ''} · ${pct.toFixed(0)}%` : `${j.done}/${j.total || '…'} · ${j.message ?? ''}`)
                : j.status === 'done' ? (j.kind === 'render' ? '✔ Completado' : '✔ Completado')
                : j.status === 'cancelled' ? 'Cancelado' : `✖ ${j.message ?? 'Error'}`}
              {j.status === 'done' && j.message ? `\n⚠ ${j.message}` : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const { page, go, toast } = useStore()
  useEffect(() => initJobListener(), [])
  useEffect(() => initUpdateListener(), [])
  const view = { inicio: <Home />, biblioteca: <Library />, crear: <Create />, editor: <Editor />, proyectos: <Projects />, generados: <Generated />, plantillas: <Templates />, ia: <AI />, config: <Settings /> }[page]
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">Clip<b>Forge</b></div>
        {NAV.map(([id, ic, label]) => (
          <button key={id} className={'nav' + (page === id ? ' on' : '')} onClick={() => go(id)}><span className="ic">{ic}</span>{label}</button>
        ))}
        <div style={{ marginTop: 'auto' }}><UpdateBox compact /></div>
      </aside>
      <main className={'main' + (page === 'editor' ? ' ed-main' : '')}>{view}</main>
      <JobBar />
      {toast && <div className={'toast' + (toast.kind === 'err' ? ' err' : '')}>{toast.msg}</div>}
    </div>
  )
}
