import { useEffect, useRef, useState } from 'react'
import type { TextStyle } from '@shared/types'
import { drawText, listFonts, CANVAS_H, CANVAS_W } from '../textRender'

type P = { style: TextStyle; onChange: (patch: Partial<TextStyle>) => void }

function Num({ label, v, min, max, step = 1, set, unit = '' }: { label: string; v: number; min: number; max: number; step?: number; set: (n: number) => void; unit?: string }): React.JSX.Element {
  return (
    <label className="f"><span>{label}: <b>{Math.round(v * 100) / 100}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} /></label>
  )
}

export function TextStyleEditor({ style, onChange }: P): React.JSX.Element {
  const [fonts, setFonts] = useState<string[]>([])
  useEffect(() => { void listFonts().then(setFonts) }, [])
  const list = fonts.includes(style.fontFamily) ? fonts : [style.fontFamily, ...fonts]
  return (
    <div className="col">
      <label className="f"><span>Tipografía</span>
        <select value={style.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })} style={{ fontFamily: style.fontFamily }}>
          {list.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select></label>
      <div className="grid g2">
        <Num label="Tamaño" v={style.fontSize} min={30} max={180} set={(n) => onChange({ fontSize: n })} unit="px" />
        <label className="f"><span>Grosor</span>
          <select value={style.fontWeight} onChange={(e) => onChange({ fontWeight: Number(e.target.value) })}>
            <option value={400}>Normal</option><option value={600}>Seminegrita</option><option value={700}>Negrita</option><option value={900}>Extranegrita</option>
          </select></label>
      </div>
      <div className="row wrap">
        <label className="f"><span>Color</span><input type="color" value={style.color} onChange={(e) => onChange({ color: e.target.value })} /></label>
        <div className="chips" style={{ marginTop: 14 }}>
          {(['left', 'center', 'right'] as const).map((a) => <span key={a} className={'chip' + (style.align === a ? ' on' : '')} onClick={() => onChange({ align: a })}>{a === 'left' ? '⬅ Izq.' : a === 'center' ? '⬌ Centro' : 'Der. ➡'}</span>)}
          <span className={'chip' + (style.uppercase ? ' on' : '')} onClick={() => onChange({ uppercase: !style.uppercase })}>AA Mayúsculas</span>
        </div>
      </div>
      <div className="grid g2">
        <Num label="Posición horizontal" v={style.x} min={0} max={1} step={0.01} set={(n) => onChange({ x: n })} />
        <Num label="Posición vertical" v={style.y} min={0} max={1} step={0.01} set={(n) => onChange({ y: n })} />
        <Num label="Ancho del bloque" v={style.maxWidth} min={0.3} max={1} step={0.01} set={(n) => onChange({ maxWidth: n })} />
        <Num label="Interlineado" v={style.lineHeight} min={0.9} max={1.8} step={0.01} set={(n) => onChange({ lineHeight: n })} />
      </div>
      <div className="row"><button className="btn sm" onClick={() => onChange({ x: 0.5, y: 0.5 })}>Centrar en pantalla</button></div>
      <div className="grid g2">
        <div className="col">
          <label className="ck"><input type="checkbox" checked={style.shadow} onChange={(e) => onChange({ shadow: e.target.checked })} />Sombra</label>
          {style.shadow && <Num label="Desenfoque" v={style.shadowBlur} min={0} max={40} set={(n) => onChange({ shadowBlur: n })} />}
        </div>
        <div className="col">
          <label className="ck"><input type="checkbox" checked={style.outline} onChange={(e) => onChange({ outline: e.target.checked })} />Contorno</label>
          {style.outline && <div className="row"><input type="color" value={style.outlineColor} onChange={(e) => onChange({ outlineColor: e.target.value })} /><div className="grow"><Num label="Grosor" v={style.outlineWidth} min={1} max={20} set={(n) => onChange({ outlineWidth: n })} /></div></div>}
        </div>
      </div>
      <label className="ck"><input type="checkbox" checked={style.wholeVideo} onChange={(e) => onChange({ wholeVideo: e.target.checked })} />El texto permanece durante todo el video</label>
      {!style.wholeVideo && (
        <div className="grid g2">
          <label className="f"><span>Aparece en (s)</span><input type="number" min={0} step={0.5} value={style.startAt} onChange={(e) => onChange({ startAt: Math.max(0, Number(e.target.value)) })} /></label>
          <label className="f"><span>Desaparece en (s, vacío = al final)</span><input type="number" min={0} step={0.5} value={style.endAt ?? ''} onChange={(e) => onChange({ endAt: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        </div>
      )}
    </div>
  )
}

/** Vista previa en tiempo real del texto sobre un fondo (o una miniatura). */
export function TextPreview({ text, style, bg }: { text: string; style: TextStyle; bg?: string | null }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      const w = c.clientWidth * devicePixelRatio
      c.width = w; c.height = w * (CANVAS_H / CANVAS_W)
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, c.width, c.height)
      drawText(ctx, text || 'Tu texto aquí', style, c.width / CANVAS_W)
    })
    return () => { cancelled = true }
  })
  return (
    <div className="phone">
      <div className="ph" style={bg ? { background: `center/cover url("${bg}")` } : undefined} />
      <canvas ref={ref} />
    </div>
  )
}
