// Motor de selección de fragmentos. Lógica pura (sin Electron ni FFmpeg) para poder probarla.
import type { GenSettings, Plan, Segment, VideoAsset } from './types'

export interface Range { videoId: number; start: number; duration: number }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let uidCounter = 0
const uid = (): string => `s${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`

/** Decide cuántos fragmentos y de qué duración según los ajustes. */
export function resolveTimings(s: GenSettings, rng: () => number): number[] {
  const T = s.duration
  let n: number
  if (s.segmentCount && !s.auto) n = Math.max(1, Math.round(s.segmentCount))
  else {
    let avg: number
    if (s.segmentLength && !s.auto) avg = s.segmentLength
    else if (s.auto) avg = T <= 15 ? 1.3 : T <= 30 ? 1.7 : 2.1
    else avg = s.speed === 'rapido' ? 0.9 : s.speed === 'lento' ? 2.6 : 1.6
    n = Math.max(2, Math.round(T / Math.max(0.4, avg)))
  }
  n = Math.min(n, Math.floor(T / 0.4))
  const w = Array.from({ length: n }, () => 0.72 + rng() * 0.56)
  const sum = w.reduce((a, b) => a + b, 0)
  const d = w.map((x) => Math.max(0.4, (x / sum) * T))
  const fix = T - d.reduce((a, b) => a + b, 0) // corrige redondeos para sumar exactamente T
  d[d.length - 1] = Math.max(0.4, d[d.length - 1] + fix)
  return d.map((x) => Math.round(x * 100) / 100)
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean { return a0 < b1 && b0 < a1 }

/** Intervalos de inicio libres [lo,hi] dentro del video para un fragmento de longitud len. */
function freeStarts(v: VideoAsset, len: number, blocked: Range[], pad: number): Array<[number, number]> {
  const maxStart = v.duration - len - 0.05
  if (maxStart < 0) return []
  // Un inicio s es válido si [s, s+len] no solapa ningún bloqueo (con margen).
  const forb: Array<[number, number]> = blocked
    .filter((b) => b.videoId === v.id)
    .map((b) => [b.start - len - pad, b.start + b.duration + pad] as [number, number])
    .sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  let cur = 0
  for (const [lo, hi] of forb) {
    if (lo > cur) out.push([cur, Math.min(lo, maxStart)])
    cur = Math.max(cur, hi)
  }
  if (cur <= maxStart) out.push([cur, maxStart])
  return out.filter(([a, b]) => b - a >= 0 && a <= maxStart)
}

function pickStart(v: VideoAsset, len: number, blocked: Range[], rng: () => number, pad = 0.4): number | null {
  const iv = freeStarts(v, len, blocked, pad)
  if (!iv.length) return null
  const total = iv.reduce((s, [a, b]) => s + (b - a), 0)
  let start: number
  if (total <= 0.001) start = iv[0][0]
  else {
    let r = rng() * total
    start = iv[0][0]
    for (const [a, b] of iv) {
      if (r <= b - a) { start = a + r; break }
      r -= b - a
    }
  }
  // Ajusta al cambio de escena más cercano (si se analizaron) para cortes más limpios.
  if (v.scenes?.length) {
    let best: number | null = null
    let bd = 1.2
    for (const sc of v.scenes) {
      const d = Math.abs(sc - start)
      if (d < bd && iv.some(([a, b]) => sc >= a && sc <= b)) { best = sc; bd = d }
    }
    if (best !== null) start = best
  }
  return Math.max(0, Math.min(start, v.duration - len - 0.05))
}

export interface PlanInput {
  videos: VideoAsset[]
  settings: GenSettings
  used: Range[] // historial de proyectos anteriores
  avoid?: Range[] // ya usados en este lote
  seed: number
  /** Puntuaciones opcionales 0..1 (p. ej. de IA) por id de video. */
  scores?: Map<number, number>
}

function usageCounts(used: Range[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const u of used) m.set(u.videoId, (m.get(u.videoId) ?? 0) + 1)
  return m
}

function weightedPick<T>(items: T[], weight: (t: T) => number, rng: () => number): T {
  const w = items.map(weight)
  const total = w.reduce((a, b) => a + b, 0)
  if (total <= 0) return items[Math.floor(rng() * items.length)]
  let r = rng() * total
  for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i] }
  return items[items.length - 1]
}

/** Elige un fragmento (video + inicio) de longitud len evitando solapes y repeticiones. */
export function pickSegment(
  videos: VideoAsset[], len: number, blocked: Range[], planVideoCount: Map<number, number>,
  usage: Map<number, number>, rng: () => number, scores?: Map<number, number>
): { video: VideoAsset; start: number } | null {
  const fit = videos.filter((v) => v.duration >= len + 0.1)
  if (!fit.length) return null
  const weight = (v: VideoAsset): number => {
    const inPlan = planVideoCount.get(v.id) ?? 0
    const hist = usage.get(v.id) ?? 0
    const score = scores?.get(v.id) ?? 0.5
    return (0.25 + score) / ((1 + hist * 0.6) * Math.pow(6, inPlan))
  }
  const pool = [...fit]
  while (pool.length) {
    const v = weightedPick(pool, weight, rng)
    const start = pickStart(v, len, blocked, rng)
    if (start !== null) return { video: v, start: Math.round(start * 100) / 100 }
    pool.splice(pool.indexOf(v), 1)
  }
  return null
}

export function makePlan(input: PlanInput): Plan {
  const rng = mulberry32(input.seed)
  const { videos, settings } = input
  if (!videos.length) throw new Error('La biblioteca no tiene videos utilizables')
  const lens = resolveTimings(settings, rng)
  const usage = usageCounts(input.used)
  const planCount = new Map<number, number>()
  const chosen: Range[] = []
  const segments: Segment[] = []
  for (const len of lens) {
    // 1.º intento: evitar historial + lote + plan actual. 2.º: solo plan actual y lote. 3.º: solo plan actual.
    const tiers: Range[][] = [
      [...input.used, ...(input.avoid ?? []), ...chosen],
      [...(input.avoid ?? []), ...chosen],
      [...chosen]
    ]
    let pick: { video: VideoAsset; start: number } | null = null
    for (const blocked of tiers) {
      pick = pickSegment(videos, len, blocked, planCount, usage, rng, input.scores)
      if (pick) break
    }
    if (!pick) {
      // Ningún video es lo bastante largo: acorta usando el más largo disponible.
      const longest = [...videos].sort((a, b) => b.duration - a.duration)[0]
      const l = Math.max(0.3, Math.min(len, longest.duration - 0.1))
      pick = { video: longest, start: Math.max(0, Math.round(rng() * (longest.duration - l) * 100) / 100) }
      segments.push({ uid: uid(), videoId: pick.video.id, start: pick.start, duration: Math.round(l * 100) / 100 })
      chosen.push({ videoId: pick.video.id, start: pick.start, duration: l })
      continue
    }
    planCount.set(pick.video.id, (planCount.get(pick.video.id) ?? 0) + 1)
    chosen.push({ videoId: pick.video.id, start: pick.start, duration: len })
    segments.push({ uid: uid(), videoId: pick.video.id, start: pick.start, duration: len })
  }
  return { segments, seed: input.seed }
}

/** Sustituye un fragmento por otro distinto manteniendo su duración. */
export function replaceSegment(plan: Plan, index: number, videos: VideoAsset[], used: Range[], seed: number, scores?: Map<number, number>): Plan {
  const rng = mulberry32(seed)
  const target = plan.segments[index]
  const others = plan.segments.filter((_, i) => i !== index)
  const blocked: Range[] = [...used, ...others.map((s) => ({ videoId: s.videoId, start: s.start, duration: s.duration })), { videoId: target.videoId, start: target.start, duration: target.duration }]
  const planCount = new Map<number, number>()
  for (const s of others) planCount.set(s.videoId, (planCount.get(s.videoId) ?? 0) + 1)
  const pick = pickSegment(videos, target.duration, blocked, planCount, usageCounts(used), rng, scores)
    ?? pickSegment(videos, target.duration, blocked.slice(used.length), planCount, usageCounts(used), rng, scores)
  if (!pick) return plan
  const segs = [...plan.segments]
  segs[index] = { ...target, uid: uid(), videoId: pick.video.id, start: pick.start }
  return { ...plan, segments: segs }
}

/** Regenera toda la selección con otra semilla. */
export function regenerate(input: PlanInput): Plan { return makePlan({ ...input, seed: (input.seed * 1664525 + 1013904223) >>> 0 }) }

/** Clave estable de una combinación (para registrar y evitar repeticiones). */
export function comboKey(segments: Array<Pick<Segment, 'videoId' | 'start'>>): string {
  const parts = segments.map((s) => `${s.videoId}@${Math.round(s.start * 2) / 2}`).sort().join('|')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < parts.length; i++) {
    const c = parts.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c, 2246822519) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + '-' + segments.length
}

export function totalDuration(segments: Array<Pick<Segment, 'duration'>>): number {
  return Math.round(segments.reduce((a, s) => a + s.duration, 0) * 100) / 100
}
