// Modelo del editor de video (línea de tiempo). Lógica pura, sin Electron ni DOM, para poder probarla.
// El editor de Android implementa EXACTAMENTE las mismas reglas (android/.../editor/EditorModel.kt).
import { DEFAULT_TEXT_STYLE, type TextStyle } from './types'

export const MIN_CLIP = 0.3 // s de línea de tiempo
export const MIN_TEXT = 0.3
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

/** Un tramo de un video de la biblioteca. Dura (srcEnd - srcStart) / speed en la línea de tiempo. */
export interface EClip {
  id: string; videoId: number; srcStart: number; srcEnd: number; speed: number; volume: number
  // Aspecto del clip (todos opcionales: ausente = valor por defecto; ver clipLook).
  fadeIn?: number; fadeOut?: number // s: fundido desde/hacia negro (imagen y sonido)
  bright?: number; contrast?: number; sat?: number; warmth?: number; filter?: string
  kScale?: number; kPx?: number; kPy?: number // animación: valores al FINAL del clip (los de arriba son los del inicio); ausente = sin animar
  scale?: number; rot?: number; flip?: boolean; px?: number; py?: number // encuadre: zoom, giro (grados, sentido horario), espejo, desplazamiento (fraccion del cuadro)
}
/** Una pista de audio colocada en la linea de tiempo (efectos, voz, musica extra). Suena una vez desde start. */
export interface EAudio { id: string; path: string; name: string; kind: 'music' | 'sfx' | 'voice'; start: number; duration: number; volume: number; fadeIn: number; fadeOut: number }
/** Un texto con su tiempo. La posición, tamaño y estilo viven en `style` (x, y = centro del bloque, 0..1). */
export type TextAnim = 'none' | 'fade' | 'up' | 'down' | 'left' | 'right'
export interface EText { id: string; text: string; start: number; duration: number; style: TextStyle; anim?: TextAnim; animDur?: number }
export const ANIM_DIST = 120 // px (en el cuadro de 1080x1920) que recorre una animación de deslizamiento
export interface EMusic { path: string; name: string; volume: number }
export interface EditorProject {
  id: number | null
  name: string
  clips: EClip[]
  texts: EText[]
  music: EMusic | null
  audios?: EAudio[]
  fps: 30 | 60
  quality: 'alta' | 'media' | 'rapida'
}

export const newProject = (): EditorProject => ({ id: null, name: 'Proyecto del editor', clips: [], texts: [], music: null, audios: [], fps: 30, quality: 'media' })

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

export const MIN_AUDIO = 0.2
export const FILTERS: Record<string, { bright: number; contrast: number; sat: number; warmth: number }> = {
  none: { bright: 0, contrast: 1, sat: 1, warmth: 0 },
  vivid: { bright: 0.02, contrast: 1.15, sat: 1.4, warmth: 0.05 },
  warm: { bright: 0.02, contrast: 1.05, sat: 1.1, warmth: 0.5 },
  cool: { bright: 0, contrast: 1.05, sat: 1, warmth: -0.5 },
  bw: { bright: 0, contrast: 1.1, sat: 0, warmth: 0 },
  vintage: { bright: 0.03, contrast: 0.9, sat: 0.7, warmth: 0.35 },
  dramatic: { bright: -0.03, contrast: 1.35, sat: 0.9, warmth: -0.1 }
}

export interface ClipLook { fadeIn: number; fadeOut: number; bright: number; contrast: number; sat: number; warmth: number; scale: number; rot: number; flip: boolean; px: number; py: number; kScale: number; kPx: number; kPy: number; animated: boolean }
/** Aspecto completo del clip con los valores por defecto aplicados. Los fundidos nunca pasan de la mitad del clip. */
export function clipLook(c: EClip): ClipLook {
  const half = clipDur(c) / 2
  return {
    fadeIn: clamp(c.fadeIn ?? 0, 0, half), fadeOut: clamp(c.fadeOut ?? 0, 0, half),
    bright: c.bright ?? 0, contrast: c.contrast ?? 1, sat: c.sat ?? 1, warmth: c.warmth ?? 0,
    scale: c.scale ?? 1, rot: c.rot ?? 0, flip: c.flip ?? false, px: c.px ?? 0, py: c.py ?? 0,
    kScale: c.kScale ?? c.scale ?? 1, kPx: c.kPx ?? c.px ?? 0, kPy: c.kPy ?? c.py ?? 0,
    animated: (c.kScale ?? c.scale ?? 1) !== (c.scale ?? 1) || (c.kPx ?? c.px ?? 0) !== (c.px ?? 0) || (c.kPy ?? c.py ?? 0) !== (c.py ?? 0)
  }
}
/** Zoom y posición del clip en la fracción u (0 = inicio, 1 = final) de su duración. */
export function frameAt(c: EClip, u: number): { scale: number; px: number; py: number } {
  const l = clipLook(c); const k = clamp(u, 0, 1)
  return { scale: l.scale + (l.kScale - l.scale) * k, px: l.px + (l.kPx - l.px) * k, py: l.py + (l.kPy - l.py) * k }
}
/** Necesita correccion de color? (si no, la exportacion usa el camino rapido) */
export const hasColor = (c: EClip): boolean => { const l = clipLook(c); return l.bright !== 0 || l.contrast !== 1 || l.sat !== 1 || l.warmth !== 0 }
export const hasFrame = (c: EClip): boolean => { const l = clipLook(c); return l.scale !== 1 || l.rot !== 0 || l.flip || l.px !== 0 || l.py !== 0 || l.animated }

/** Mantiene textos y audios dentro de la duración del video (tras cortar, borrar o cambiar velocidades). */
export function normalize(p: EditorProject): EditorProject {
  const total = totalDuration(p)
  const audios = (p.audios ?? []).map((a) => {
    const start = clamp(a.start, 0, Math.max(0, total - MIN_AUDIO))
    const duration = clamp(a.duration, Math.min(MIN_AUDIO, total - start), Math.max(0, total - start))
    return start === a.start && duration === a.duration ? a : { ...a, start: r3(start), duration: r3(duration) }
  }).filter((a) => total > 0 && a.duration > 0)
  p = { ...p, audios }
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

type ClipPatch = Partial<Pick<EClip, 'kScale' | 'kPx' | 'kPy' | 'speed' | 'volume' | 'fadeIn' | 'fadeOut' | 'bright' | 'contrast' | 'sat' | 'warmth' | 'filter' | 'scale' | 'rot' | 'flip' | 'px' | 'py'>>
const RANGES: Record<string, [number, number]> = { volume: [0, 1], fadeIn: [0, 3], fadeOut: [0, 3], bright: [-0.5, 0.5], contrast: [0.5, 1.5], sat: [0, 2], warmth: [-1, 1], scale: [0.25, 4], rot: [-180, 180], px: [-1, 1], py: [-1, 1], kScale: [0.25, 4], kPx: [-1, 1], kPy: [-1, 1] }
export function setClip(p: EditorProject, id: string, patch: ClipPatch): EditorProject {
  return withClips(p, p.clips.map((c) => {
    if (c.id !== id) return c
    const n: EClip = { ...c }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      if (k === 'speed') n.speed = clamp(v as number, 0.25, 4)
      else if (k === 'flip') n.flip = !!v
      else if (k === 'filter') n.filter = v as string
      else { const [lo, hi] = RANGES[k]; (n as unknown as Record<string, number>)[k] = r3(clamp(v as number, lo, hi)) }
    }
    return n
  }))
}

/** Movimientos prediseñados (zoom/paneo de inicio a fin del clip). 'none' quita la animación. */
export function applyMotion(p: EditorProject, id: string, name: 'none' | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight'): EditorProject {
  const clear = (c: EClip): EClip => { const { kScale: _a, kPx: _b, kPy: _c, ...rest } = c; return rest }
  return withClips(p, p.clips.map((c) => {
    if (c.id !== id) return c
    const base = clear(c)
    switch (name) {
      case 'none': return base
      case 'zoomIn': return { ...base, scale: 1, px: 0, py: 0, kScale: 1.3, kPx: 0, kPy: 0 }
      case 'zoomOut': return { ...base, scale: 1.3, px: 0, py: 0, kScale: 1, kPx: 0, kPy: 0 }
      case 'panLeft': return { ...base, scale: 1.25, px: 0.1, py: 0, kScale: 1.25, kPx: -0.1, kPy: 0 }
      case 'panRight': return { ...base, scale: 1.25, px: -0.1, py: 0, kScale: 1.25, kPx: 0.1, kPy: 0 }
    }
  }))
}

/** Aplica un filtro prediseñado (ajusta brillo, contraste, saturación y calidez). */
export function applyFilter(p: EditorProject, id: string, name: string): EditorProject {
  const f = FILTERS[name]
  return f ? setClip(p, id, { ...f, filter: name }) : p
}

/** Transición entre el clip index y el siguiente: fundido a negro de dur s a cada lado (0 la quita). */
export function setTransition(p: EditorProject, index: number, dur: number): EditorProject {
  if (index < 0 || index >= p.clips.length - 1) return p
  const d = r3(clamp(dur, 0, 3))
  return withClips(p, p.clips.map((c, i) => i === index ? { ...c, fadeOut: d } : i === index + 1 ? { ...c, fadeIn: d } : c))
}
/** Duración de la transición en la unión entre index e index+1 (0 si no hay). */
export const transitionAt = (p: EditorProject, index: number): number => {
  const a = p.clips[index]; const b = p.clips[index + 1]
  return a && b ? Math.min(clipLook(a).fadeOut, clipLook(b).fadeIn) : 0
}

// ---------- animación de textos y stickers ----------
const ANIM_DIR: Record<TextAnim, [number, number]> = { none: [0, 0], fade: [0, 0], up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }
/** Duración efectiva de la animación de un texto (nunca más de la mitad de lo que dura). */
export const animLen = (t: EText): number => (t.anim && t.anim !== 'none') ? clamp(t.animDur ?? 0.4, 0.1, t.duration / 2) : 0
/** Transparencia (0..1) y desplazamiento (px del cuadro 1080x1920) de un texto en el instante t. Entra con la animación y sale con ella. */
export function textAnim(t: EText, time: number): { alpha: number; dx: number; dy: number } {
  const d = animLen(t)
  if (d <= 0) return { alpha: 1, dx: 0, dy: 0 }
  const lt = time - t.start
  const pin = clamp(lt / d, 0, 1); const pout = clamp((t.duration - lt) / d, 0, 1)
  const [vx, vy] = ANIM_DIR[t.anim ?? 'none']
  const off = ((1 - pin) - (1 - pout)) * ANIM_DIST
  return { alpha: Math.min(pin, pout), dx: vx * off, dy: vy * off }
}
/** Agrega un sticker (emoji grande) en at, con una animación de entrada. */
export function addSticker(p: EditorProject, at: number, emoji: string, style: TextStyle = DEFAULT_TEXT_STYLE): { project: EditorProject; selectId: string } {
  const r = addText(p, at, emoji, { ...style, fontSize: 200, outline: false, shadow: false, x: 0.5, y: 0.4, uppercase: false })
  return { project: setText(r.project, r.selectId, { duration: Math.min(3, r.project.texts.find((t) => t.id === r.selectId)!.duration), anim: 'up', animDur: 0.4 }), selectId: r.selectId }
}

// ---------- pistas de audio ----------
/** Agrega una pista en at. fileDur es la duración del archivo (0 si se desconoce: entonces ocupa hasta el final). */
export function addAudio(p: EditorProject, path: string, name: string, kind: EAudio['kind'], at: number, fileDur = 0): { project: EditorProject; selectId: string } {
  const total = totalDuration(p)
  const start = clamp(at, 0, Math.max(0, total - MIN_AUDIO))
  const room = Math.max(MIN_AUDIO, total - start)
  const a: EAudio = { id: eid('a'), path, name, kind, start: r3(start), duration: r3(fileDur > 0 ? Math.min(fileDur, room) : room), volume: kind === 'music' ? 0.8 : 1, fadeIn: 0, fadeOut: 0 }
  return { project: normalize({ ...p, audios: [...(p.audios ?? []), a] }), selectId: a.id }
}
export const setAudio = (p: EditorProject, id: string, patch: Partial<Pick<EAudio, 'volume' | 'fadeIn' | 'fadeOut' | 'start' | 'duration'>>): EditorProject =>
  normalize({ ...p, audios: (p.audios ?? []).map((a) => {
    if (a.id !== id) return a
    const n = { ...a, ...patch }
    n.volume = clamp(n.volume, 0, 1); n.fadeIn = clamp(n.fadeIn, 0, n.duration / 2); n.fadeOut = clamp(n.fadeOut, 0, n.duration / 2)
    return n
  }) })
export const removeAudio = (p: EditorProject, id: string): EditorProject => ({ ...p, audios: (p.audios ?? []).filter((a) => a.id !== id) })
export function moveAudio(p: EditorProject, id: string, start: number): EditorProject {
  const a = (p.audios ?? []).find((x) => x.id === id)
  return a ? setAudio(p, id, { start: r3(clamp(start, 0, Math.max(0, totalDuration(p) - a.duration))) }) : p
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

// ---------- subtítulos desde un guion ----------
/** Divide un guion en frases cortas: máximo `maxWords` palabras y corte natural tras puntuación. */
export function splitCaptions(text: string, maxWords = 4): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const out: string[] = []
  let cur: string[] = []
  for (const w of words) {
    cur.push(w)
    const stop = /[.!?…;:]$/.test(w) || (/,$/.test(w) && cur.length >= 2)
    if (cur.length >= Math.max(1, maxWords) || (stop && cur.length >= 2) || (/[.!?…]$/.test(w))) { out.push(cur.join(' ')); cur = [] }
  }
  if (cur.length) { if (out.length && cur.length === 1 && out[out.length - 1].split(' ').length < Math.max(1, maxWords) * 2) out[out.length - 1] += ' ' + cur[0]; else out.push(cur.join(' ')) }
  return out
}

/**
 * Reparte las frases del guion por la línea de tiempo entre `from` y `to` (por defecto, todo el video), cada una con
 * una duración proporcional a su longitud. Los subtítulos son textos normales: se pueden mover, editar y borrar.
 */
export function captionsFromText(p: EditorProject, text: string, style: TextStyle, opts: { from?: number; to?: number; maxWords?: number } = {}): { project: EditorProject; ids: string[] } {
  const total = totalDuration(p)
  const from = clamp(opts.from ?? 0, 0, Math.max(0, total - MIN_TEXT))
  const to = clamp(opts.to ?? total, from + MIN_TEXT, Math.max(total, from + MIN_TEXT))
  const parts = total > 0 ? splitCaptions(text, opts.maxWords ?? 4) : []
  if (!parts.length) return { project: p, ids: [] }
  const span = Math.min(to, total) - from
  const weights = parts.map((s) => s.length + 4)
  const sum = weights.reduce((a, b) => a + b, 0)
  let t = from
  const texts: EText[] = parts.map((s, i) => {
    const d = i === parts.length - 1 ? from + span - t : (span * weights[i]) / sum
    const e: EText = { id: eid('t'), text: s, start: r3(t), duration: r3(Math.max(MIN_TEXT, d)), style: { ...style, wholeVideo: true, startAt: 0, endAt: null } }
    t += d
    return e
  })
  const next = normalize({ ...p, texts: [...p.texts, ...texts] })
  return { project: next, ids: texts.map((x) => x.id) }
}
