import { useCallback, useEffect, useRef, useState } from 'react'
import type { Library as Lib, VideoAsset } from '@shared/types'
import { api, errMsg, fmtDur, fmtSize, mediaUrl } from '../api'
import { useStore } from '../store'

const PAGE = 120

export default function Library(): React.JSX.Element {
  const { libVersion, notify, bumpLib } = useStore()
  const [libs, setLibs] = useState<Lib[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const [items, setItems] = useState<VideoAsset[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [over, setOver] = useState(false)
  const [url, setUrl] = useState('')
  const [showUrl, setShowUrl] = useState(false)
  const searchRef = useRef(search)
  searchRef.current = search

  const loadLibs = useCallback(async () => {
    const l = await api.libraries()
    setLibs(l)
    setSel((cur) => (cur !== null && l.some((x) => x.id === cur) ? cur : l[0]?.id ?? null))
  }, [])
  useEffect(() => { void loadLibs() }, [loadLibs, libVersion])

  const loadVideos = useCallback(async (append: boolean, offset = 0) => {
    if (sel === null) { setItems([]); setTotal(0); return }
    const r = await api.videos(sel, { search: searchRef.current, limit: PAGE, offset })
    setItems((p) => (append ? [...p, ...r.items] : r.items)); setTotal(r.total)
  }, [sel])
  useEffect(() => { void loadVideos(false) }, [loadVideos, libVersion, search])

  const lib = libs.find((l) => l.id === sel) ?? null
  const guard = async (fn: () => Promise<unknown>): Promise<void> => { try { await fn() } catch (e) { notify(errMsg(e), 'err') } }

  const ensureLib = async (): Promise<number> => {
    if (sel !== null) return sel
    const id = await api.createLibrary('Mi biblioteca'); await loadLibs(); setSel(id); return id
  }
  const addPaths = (paths: string[]): Promise<void> => guard(async () => { if (paths.length) await api.importPaths(await ensureLib(), paths) })

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault(); setOver(false)
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
    void addPaths(paths)
  }

  const newLib = (): Promise<void> => guard(async () => {
    const name = prompt('Nombre de la biblioteca', `Biblioteca ${libs.length + 1}`)
    if (!name) return
    const id = await api.createLibrary(name); await loadLibs(); setSel(id)
  })

  return (
    <div>
      <div className="page-head">
        <div><h1>Biblioteca de videos</h1><div className="muted">Importa carpetas completas, discos externos o carpetas sincronizadas (Drive, Dropbox, OneDrive). Los videos no se copian: se usan desde su ubicación.</div></div>
        <button className="btn primary" onClick={newLib}>+ Nueva biblioteca</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 18 }}>
        <div className="liblist">
          {!libs.length && <div className="empty small">Aún no hay bibliotecas. Arrastra una carpeta aquí a la derecha y se creará una automáticamente.</div>}
          {libs.map((l) => (
            <div key={l.id} className={'libitem' + (l.id === sel ? ' on' : '')} onClick={() => setSel(l.id)}>
              <b>{l.name}</b>
              <div className="muted small">{l.videoCount} videos · {fmtDur(l.totalDuration)} · {fmtSize(l.totalSize)}</div>
              {l.duplicateCount > 0 && <div className="small" style={{ color: 'var(--warn)' }}>{l.duplicateCount} duplicados (no se usarán)</div>}
            </div>
          ))}
        </div>
        <div className="col">
          <div className={'drop' + (over ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <div className="row wrap" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => guard(async () => addPaths(await api.pickFolders()))}>📂 Añadir carpeta</button>
              <button className="btn" onClick={() => guard(async () => addPaths(await api.pickVideos()))}>🎞️ Añadir archivos</button>
              <button className="btn" onClick={() => setShowUrl((v) => !v)}>🔗 Pegar enlace</button>
              {lib && <>
                <button className="btn" onClick={() => guard(async () => { const r = await api.verifyLibrary(lib.id); bumpLib(); notify(r.missing ? `${r.missing} archivos no encontrados (disco desconectado o movidos)` : 'Todos los archivos están disponibles') })}>Verificar archivos</button>
                <button className="btn" title="Detección local con FFmpeg, mejora la calidad de los cortes" onClick={() => guard(() => api.analyzeScenes(lib.id))}>Detectar escenas</button>
              </>}
            </div>
            <div className="small" style={{ marginTop: 8 }}>…o arrastra aquí carpetas y archivos (MP4, MOV, AVI, MKV, WebM y más)</div>
            {showUrl && (
              <div className="row" style={{ marginTop: 10 }}>
                <input type="url" placeholder="https://…/video.mp4 (enlace directo al archivo)" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="btn primary" disabled={!url} onClick={() => guard(async () => { await api.importUrl(await ensureLib(), url.trim()); setUrl(''); setShowUrl(false) })}>Descargar</button>
              </div>
            )}
          </div>
          {lib && (
            <div className="row sp">
              <div className="row"><input type="text" style={{ width: 260 }} placeholder="Buscar por nombre…" value={search} onChange={(e) => setSearch(e.target.value)} /><span className="muted small">{total} resultados</span></div>
              <div className="row">
                <button className="btn sm" onClick={() => guard(async () => { const n = prompt('Nuevo nombre', lib.name); if (n) { await api.renameLibrary(lib.id, n); bumpLib() } })}>Renombrar</button>
                <button className="btn sm danger" onClick={() => guard(async () => { if (confirm(`¿Quitar la biblioteca "${lib.name}"? Los archivos de video NO se borran.`)) { await api.deleteLibrary(lib.id); bumpLib() } })}>Eliminar biblioteca</button>
              </div>
            </div>
          )}
          {lib && !items.length && <div className="empty">Esta biblioteca está vacía.</div>}
          <div className="vgrid">
            {items.map((v) => (
              <div className="vcard" key={v.id} title={v.path}>
                <div className="th" style={v.thumb ? { backgroundImage: `url("${mediaUrl(v.thumb)}")` } : undefined}>{!v.thumb && 'Sin miniatura'}</div>
                {v.dupOf && <span className="badge dup">Duplicado</span>}
                {v.missing && <span className="badge miss">No encontrado</span>}
                <span className="dur">{v.duration.toFixed(1)}s</span>
                <button className="btn sm danger x" title="Quitar de la biblioteca" onClick={() => guard(async () => { await api.removeVideo(v.id); bumpLib() })}>✕</button>
                <div className="meta"><div className="nm">{v.name}</div><div className="muted">{v.width}×{v.height} · {v.format} · {fmtSize(v.size)}{v.scenes ? ` · ${v.scenes.length} esc.` : ''}</div></div>
              </div>
            ))}
          </div>
          {items.length < total && <button className="btn" onClick={() => void loadVideos(true, items.length)}>Cargar más ({total - items.length} restantes)</button>}
        </div>
      </div>
    </div>
  )
}
