// Modelo del editor de video (línea de tiempo). Lógica pura, sin Electron ni DOM, para poder probarla.
// El editor de Android implementa EXACTAMENTE las mismas reglas (android/.../editor/EditorModel.kt).
import { DEFAULT_TEXT_STYLE, type TextStyle } from './types'

export const MIN_CLIP = 0.3 // s de línea de tiempo
export const MIN_TEXT = 0.3
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

/** Un tramo de un video de la biblioteca. Dura (srcEnd - srcStart) / speed en la línea de tiempo. */
export interface EClip { id: string; videoId: number; srcStart: number; srcEnd: number; speed: number; volume: number }
/** Un texto con su tiempo. La posición, tamaño y estilo viven en `style` (x, y = centro del bloque, 0..1). */
export interface EText { id: string; text: string; start: number; duration: number; style: TextStyle }
export interface EMusic { path: string; name: string; volume: number }
export interface EditorProject {
  id: number | null
  name: string
  clips: EClip[]
  texts: EText[]
  music: EMusic | null
  fps: 30 | 60
  quality: 'alta' | 'media' | 'rapida'
}

export const newProject = (): EditorProject => ({ id: null, name: 'Proyecto del editor', clips: [], texts: [], music: null, fps: 30, quality: 'media' })

let counter = 0
export const eid = (prefix = 'e'): string => prefix + Date.now().toString(36) + (counter++).toString(36) + Math.floor(Math.random() * 1296).toString(36)

const r3 = (x: number): number => Math.round(x * 1000) / 1000
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

export const clipDur = (c: EClip): number => (c.srcEnd - c.srcStart) / c.speed
export const totalDuration = (p: EditorProject): number => r3(p.clips.reduce((a, c) => a + clipDur(c), 0))

/** Inicio (en la línea de tiempo) de cada clip. */
export function clipStarts(p: EditorProject): number[] {
  const out: number[] = []
  let t = 0
  for (const c of p.clips) { out.push(t); t += clipDur(c) }
  return out
}

/** Clip que se ve en el instante t y el instante equivalente dentro del video original. */
export function locate(p: EditorProject, t: number): { index: number; start: number; src: number } | null {
  if (!p.clips.length) return null
  const starts = clipStarts(p)
  const total = totalDuration(p)
  const tt = clamp(t, 0, Math.max(0, total - 0.001))
  let i = starts.length - 1
  for (let k = 0; k < starts.length; k++) if (tt < starts[k] + clipDur(p.clips[k])) { i = k; break }
  const c = p.clips[i]
  return { index: i, start: starts[i], src: clamp(c.srcStart + (tt - starts[i]) * c.speed, c.srcStart, c.srcEnd) }
}

/** Mantiene los textos dentro de la duración del video (tras cortar, borrar o cambiar velocidades). */
export function normalize(p: EditorProject): EditorProject {
  const total = totalDuration(p)
  const texts = total <= 0 ? [] : p.texts.map((t) => {
    const start = clamp(t.start, 0, Math.max(0, total - MIN_TEXT))
    const duration = clamp(t.duration, Math.min(MIN_TEXT, total - start), total - start)
    return start === t.start && duration === t.duration ? t : { ...t, start: r3(start), duration: r3(duration) }
  })
  return { ...p, texts }
}

const withClips = (p: EditorProject, clips: EClip[]): EditorProject => normalize({ ...p, clips })

export function addClip(p: EditorProject, videoId: number, assetDuration: number, index = p.clips.length): EditorProject {
  const c: EClip = { id: eid('c'), videoId, srcStart: 0, srcEnd: r3(assetDuration), speed: 1, volume: 1 }
  const clips = [...p.clips]
  clips.splice(clamp(index, 0, clips.length), 0, c)
  return withClips(p, clips)
}

/** Divide el clip que está bajo el instante t. Devuelve null si t cae demasiado cerca de un borde. */
export function splitAt(p: EditorProject, t: number): { project: EditorProject; selectId: string } | null {
  const loc = locate(p, t)
  if (!loc) return null
  const c = p.clips[loc.index]
  const local = t - loc.start
  if (local < MIN_CLIP || clipDur(c) - local < MIN_CLIP) return null
  const cut = r3(c.srcStart + local * c.speed)
  const a: EClip = { ...c, srcEnd: cut }
  const b: EClip = { ...c, id: eid('c'), srcStart: cut }
  const clips = [...p.clips]
  clips.splice(loc.index, 1, a, b)
  return { project: withClips(p, clips), selectId: b.id }
}

/** Recorta un borde del clip. `src` es el nuevo instante dentro del video original. */
export function trimClip(p: EditorProject, id: string, side: 'start' | 'end', src: number, assetDuration: number): EditorProject {
  return withClips(p, p.clips.map((c) => {
    if (c.id !== id) return c
    const minSrc = MIN_CLIP * c.speed
    return side === 'start'
      ? { ...c, srcStart: r3(clamp(src, 0, c.srcEnd - minSrc)) }
      : { ...c, srcEnd: r3(clamp(src, c.srcStart + minSrc, assetDuration)) }
  }))
}

export function moveClip(p: EditorProject, from: number, to: number): EditorProject {
  if (from === to || from < 0 || from >= p.clips.length) return p
  const clips = [...p.clips]
  const [c] = clips.splice(from, 1)
  clips.splice(clamp(to, 0, clips.length), 0, c)
  return withClips(p, clips)
}

export const removeClip = (p: EditorProject, id: string): EditorProject => withClips(p, p.clips.filter((c) => c.id !== id))

export function duplicateClip(p: EditorProject, id: string): { project: EditorProject; selectId: string } | null {
  const i = p.clips.findIndex((c) => c.id === id)
  if (i < 0) return null
  const copy = { ...p.clips[i], id: eid('c') }
  const clips = [...p.clips]
  clips.splice(i + 1, 0, copy)
  return { project: withClips(p, clips), selectId: copy.id }
}

export function setClip(p: EditorProject, id: string, patch: Partial<Pick<EClip, 'speed' | 'volume'>>): EditorProject {
  return withClips(p, p.clips.map((c) => c.id !== id ? c : {
    ...c,
    speed: patch.speed === undefined ? c.speed : clamp(patch.speed, 0.25, 4),
    volume: patch.volume === undefined ? c.volume : clamp(patch.volume, 0, 1)
  }))
}

// ---------- textos ----------
export function addText(p: EditorProject, at: number, text = 'Tu texto', style: TextStyle = DEFAULT_TEXT_STYLE): { project: EditorProject; selectId: string } {
  const total = totalDuration(p)
  const start = clamp(at, 0, Math.max(0, total - MIN_TEXT))
  const duration = total > 0 ? clamp(3, Math.min(MIN_TEXT, total - start), total - start) : 3
  const t: EText = { id: eid('t'), text, start: r3(start), duration: r3(duration), style: { ...style, wholeVideo: true, startAt: 0, endAt: null } }
  return { project: { ...p, texts: [...p.texts, t] }, selectId: t.id }
}

export const setText = (p: EditorProject, id: string, patch: Partial<Omit<EText, 'id' | 'style'>> & { style?: Partial<TextStyle> }): EditorProject =>
  normalize({ ...p, texts: p.texts.map((t) => t.id !== id ? t : { ...t, ...patch, style: { ...t.style, ...(patch.style ?? {}) } }) })

export const removeText = (p: EditorProject, id: string): EditorProject => ({ ...p, texts: p.texts.filter((t) => t.id !== id) })

export function duplicateText(p: EditorProject, id: string): { project: EditorProject; selectId: string } | null {
  const t = p.texts.find((x) => x.id === id)
  if (!t) return null
  const copy: EText = { ...t, id: eid('t'), start: t.start, style: { ...t.style, y: Math.min(0.92, t.style.y + 0.08) } }
  return { project: normalize({ ...p, texts: [...p.texts, copy] }), selectId: copy.id }
}

/** Mueve un texto en el tiempo manteniendo su duración. */
export function moveText(p: EditorProject, id: string, start: number): EditorProject {
  const total = totalDuration(p)
  return setText(p, id, { start: r3(clamp(start, 0, Math.max(0, total - (p.texts.find((t) => t.id === id)?.duration ?? 0)))) })
}

/** Cambia el borde izquierdo (start) o derecho (end) de un texto a un instante de la línea de tiempo. */
export function resizeText(p: EditorProject, id: string, side: 'start' | 'end', time: number): EditorProject {
  const t = p.texts.find((x) => x.id === id)
  if (!t) return p
  const total = totalDuration(p)
  const end = t.start + t.duration
  if (side === 'start') { const s = clamp(time, 0, end - MIN_TEXT); return setText(p, id, { start: r3(s), duration: r3(end - s) }) }
  return setText(p, id, { duration: r3(clamp(time, t.start + MIN_TEXT, total) - t.start) })
}

/** Textos visibles en el instante t, en orden de capa (los últimos quedan encima). */
export const textsAt = (p: EditorProject, t: number): EText[] => p.texts.filter((x) => t >= x.start - 1e-6 && t < x.start + x.duration)

/** Ajusta t al punto más cercano (si está a menos de `threshold` segundos). */
export function snap(t: number, points: number[], threshold: number): number {
  let best = t
  let bd = threshold
  for (const q of points) { const d = Math.abs(q - t); if (d < bd) { best = q; bd = d } }
  return best
}

/** Puntos de imán de la línea de tiempo: inicio/fin de clips y textos y la cabeza de reproducción. */
export function snapPoints(p: EditorProject, playhead: number, exceptTextId?: string): number[] {
  const pts = [0, playhead, totalDuration(p), ...clipStarts(p)]
  for (const t of p.texts) if (t.id !== exceptTextId) pts.push(t.start, t.start + t.duration)
  return pts
}

/** Convierte una selección automática (plan) en un proyecto editable. */
export function fromPlan(segments: Array<{ videoId: number; start: number; duration: number }>, text: string, style: TextStyle, originalAudio: boolean, fps: 30 | 60, quality: EditorProject['quality'], name = 'Desde un video creado'): EditorProject {
  const clips: EClip[] = segments.map((s) => ({ id: eid('c'), videoId: s.videoId, srcStart: s.start, srcEnd: r3(s.start + s.duration), speed: 1, volume: originalAudio ? 1 : 0 }))
  let p: EditorProject = { id: null, name, clips, texts: [], music: null, fps, quality }
  if (text.trim()) p = { ...p, texts: [{ id: eid('t'), text, start: 0, duration: totalDuration(p), style: { ...style, wholeVideo: true, startAt: 0, endAt: null } }] }
  return normalize(p)
}
