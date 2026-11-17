import { useEffect, useState } from 'react'
import type { VideoAsset } from '@shared/types'
import { api, mediaUrl } from '../api'

export default function VideoPicker({ libraryId, onPick, onClose }: { libraryId: number; onPick: (v: VideoAsset) => void; onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<VideoAsset[]>([])
  const [total, setTotal] = useState(0)
  useEffect(() => { void api.videos(libraryId, { search: q, limit: 90 }).then((r) => { setItems(r.items.filter((v) => !v.dupOf && !v.missing)); setTotal(r.total) }) }, [libraryId, q])
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row sp" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Elegir video de la biblioteca</h2>
          <button className="btn" onClick={onClose}>Cerrar</button>
        </div>
        <input type="text" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
        <div className="vgrid">
          {items.map((v) => (
            <div className="vcard" key={v.id} style={{ cursor: 'pointer' }} onClick={() => onPick(v)}>
              <div className="th" style={v.thumb ? { backgroundImage: `url("${mediaUrl(v.thumb)}")` } : undefined} />
              <span className="dur">{v.duration.toFixed(1)}s</span>
              <div className="meta"><div className="nm">{v.name}</div></div>
            </div>
          ))}
        </div>
        {total > items.length && <div className="muted small" style={{ marginTop: 8 }}>Mostrando {items.length} de {total}. Usa el buscador para acotar.</div>}
      </div>
    </div>
  )
}
