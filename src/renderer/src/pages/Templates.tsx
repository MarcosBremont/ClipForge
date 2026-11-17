import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_TEXT_STYLE, type TextStyle, type TextTemplate } from '@shared/types'
import { api, errMsg } from '../api'
import { TextPreview, TextStyleEditor } from '../components/TextStyleEditor'
import { useStore } from '../store'

export default function Templates(): React.JSX.Element {
  const { notify, setDraft, go } = useStore()
  const [list, setList] = useState<TextTemplate[]>([])
  const [style, setStyle] = useState<TextStyle>({ ...DEFAULT_TEXT_STYLE })
  const [text, setText] = useState('¿Será que soy un mal hombre?')
  const [name, setName] = useState('')
  const load = useCallback(() => { void api.templates().then(setList) }, [])
  useEffect(load, [load])
  return (
    <div>
      <div className="page-head"><div><h1>Plantillas de texto</h1><div className="muted">Diseña un estilo, guárdalo y aplícalo a cualquier proyecto.</div></div></div>
      <div className="studio">
        <div className="col">
          <div className="card col">
            <h2>Editor</h2>
            <label className="f"><span>Texto de prueba</span><textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
            <TextStyleEditor style={style} onChange={(p) => setStyle({ ...style, ...p })} />
            <div className="row"><input type="text" placeholder="Nombre de la plantilla" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn primary" disabled={!name.trim()} onClick={async () => { try { await api.saveTemplate(name.trim(), style); setName(''); load(); notify('Plantilla guardada') } catch (e) { notify(errMsg(e), 'err') } }}>Guardar como plantilla</button></div>
          </div>
          <div className="card">
            <h2>Mis plantillas</h2>
            {!list.length ? <div className="empty">Aún no has guardado plantillas.</div> : (
              <table className="t"><tbody>{list.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b><div className="muted small">{t.style.fontFamily} · {t.style.fontSize}px</div></td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={() => setStyle(t.style)}>Editar</button>
                    <button className="btn sm primary" onClick={() => { setDraft({ style: t.style }); notify(`Estilo "${t.name}" aplicado al proyecto actual`); go('crear') }}>Usar en proyecto</button>
                    <button className="btn sm danger" onClick={async () => { await api.deleteTemplate(t.id); load() }}>Eliminar</button>
                  </td>
                </tr>
              ))}</tbody></table>
            )}
          </div>
        </div>
        <div style={{ position: 'sticky', top: 0 }}><TextPreview text={text} style={style} /></div>
      </div>
    </div>
  )
}
