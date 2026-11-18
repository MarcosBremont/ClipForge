// Exportación del editor de video (línea de tiempo): una sola llamada a FFmpeg.
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenSettings } from '@shared/types'
import { ANIM_DIST } from '@shared/editor'
import { OUT_H, OUT_W, encoderArgs, esc, runFfmpeg } from './render'

export interface EdClip {
  path: string; srcStart: number; srcEnd: number; speed: number; volume: number; hasAudio: boolean
  fadeIn?: number; fadeOut?: number; bright?: number; contrast?: number; sat?: number; warmth?: number
  scale?: number; rot?: number; flip?: boolean; px?: number; py?: number
  kScale?: number; kPx?: number; kPy?: number // valores al final del clip (animación)
}
export interface EdAudio { path: string; start: number; duration: number; volume: number; fadeIn: number; fadeOut: number }
export interface EdText { png: Buffer; start: number; end: number; anim?: string; animDur?: number }
export interface EditorRenderJob {
  clips: EdClip[]
  texts: EdText[]
  music: { path: string; volume: number } | null
  audios?: EdAudio[]
  fps: 30 | 60
  quality: 'alta' | 'media' | 'rapida'
  outPath: string
  tmpDir: string
  onProgress: (fraction: number) => void
  onSpawn: (p: ChildProcess) => void
  isCancelled: () => boolean
}

const afade = (fi: number, fo: number, d: number): string => (fi > 0 ? `,afade=t=in:st=0:d=${num(fi)}` : '') + (fo > 0 ? `,afade=t=out:st=${num(Math.max(0, d - fo))}:d=${num(fo)}` : '')
const clipDur = (c: EdClip): number => (c.srcEnd - c.srcStart) / c.speed
const num = (x: number): string => (Math.round(x * 10000) / 10000).toString()

/** Filtros de color y encuadre de un clip (ya reducido a 1080x1920). Vacio si el clip no los usa. Se aplica antes de los fundidos. */
function lookFilters(c: EdClip, d: number, fps: number, i: number): { pre: string; frame: string } {
  const bright = c.bright ?? 0; const contrast = c.contrast ?? 1; const sat = c.sat ?? 1; const warmth = c.warmth ?? 0
  const scale = c.scale ?? 1; const rot = c.rot ?? 0; const flip = c.flip ?? false; const px = c.px ?? 0; const py = c.py ?? 0
  let pre = ''
  if (bright !== 0 || contrast !== 1 || sat !== 1) pre += `,eq=brightness=${num(bright)}:contrast=${num(contrast)}:saturation=${num(sat)}`
  if (warmth !== 0) pre += `,colorchannelmixer=rr=${num(1 + 0.15 * warmth)}:bb=${num(1 - 0.15 * warmth)}`
  const kScale = c.kScale ?? scale; const kPx = c.kPx ?? px; const kPy = c.kPy ?? py
  const framed = scale !== 1 || rot !== 0 || flip || px !== 0 || py !== 0 || kScale !== scale || kPx !== px || kPy !== py
  if (!framed) return { pre, frame: '' }
  if (kScale !== scale || kPx !== px || kPy !== py) {
    // Animado: el zoom y la posición cambian linealmente de 0 a d segundos.
    const S = `(${num(scale)}+(${num(kScale - scale)})*t/${esc(d)})`
    let ga = flip ? ',hflip' : ''
    if (rot !== 0) { const a = num((rot * Math.PI) / 180); ga += `,rotate=${a}:ow='rotw(${a})':oh='roth(${a})':c=black` }
    ga += `,scale=w='max(2,trunc(iw*${S}/2)*2)':h='max(2,trunc(ih*${S}/2)*2)':eval=frame,setsar=1[f${i}];color=c=black:s=${OUT_W}x${OUT_H}:r=${fps}:d=${esc(d)}[bg${i}];[bg${i}][f${i}]overlay=x='(W-w)/2+(${num(px * OUT_W)}+(${num((kPx - px) * OUT_W)})*t/${esc(d)})':y='(H-h)/2+(${num(py * OUT_H)}+(${num((kPy - py) * OUT_H)})*t/${esc(d)})':shortest=1`
    return { pre, frame: ga }
  }
  // zoom -> giro (relleno negro) -> colocar sobre un fondo negro 1080x1920 con el desplazamiento.
  const w = Math.max(2, Math.round((OUT_W * scale) / 2) * 2); const h = Math.max(2, Math.round((OUT_H * scale) / 2) * 2)
  const ang = (rot * Math.PI) / 180
  let g = `${flip ? ',hflip' : ''},scale=${w}:${h}`
  if (rot !== 0) g += `,rotate=${num(ang)}:ow='rotw(${num(ang)})':oh='roth(${num(ang)})':c=black`
  g += `,setsar=1[f${i}];color=c=black:s=${OUT_W}x${OUT_H}:r=${fps}:d=${esc(d)}[bg${i}];[bg${i}][f${i}]overlay=x='(W-w)/2+${Math.round(px * OUT_W)}':y='(H-h)/2+${Math.round(py * OUT_H)}':shortest=1`
  return { pre, frame: g }
}

/** atempo solo admite 0,5–2 por filtro: se encadenan para 0,25× y 4×. */
export function atempoChain(speed: number): string {
  if (Math.abs(speed - 1) < 1e-6) return ''
  const parts: number[] = []
  let s = speed
  while (s > 2) { parts.push(2); s /= 2 }
  while (s < 0.5) { parts.push(0.5); s /= 0.5 }
  parts.push(s)
  return parts.map((x) => `atempo=${x.toFixed(4)}`).join(',') + ','
}

/** Construye el filter_complex. Exportado para pruebas. */
export function buildEditorFilter(clips: EdClip[], textRanges: Array<{ start: number; end: number; anim?: string; animDur?: number }>, music: { volume: number } | null, fps: number, audios: EdAudio[] = []): { graph: string; vLabel: string; aLabel: string; textBase: number; musicIdx: number; audioBase: number; total: number } {
  const n = clips.length
  const total = clips.reduce((a, c) => a + clipDur(c), 0)
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const c = clips[i]
    const d = clipDur(c)
    const lk = lookFilters(c, d, fps, i)
    const fi = Math.min(c.fadeIn ?? 0, d / 2); const fo = Math.min(c.fadeOut ?? 0, d / 2)
    const vfade = (fi > 0 ? `,fade=t=in:st=0:d=${num(fi)}` : '') + (fo > 0 ? `,fade=t=out:st=${num(d - fo)}:d=${num(fo)}` : '')
    const head = `[${i}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,setpts=(PTS-STARTPTS)/${c.speed.toFixed(4)},fps=${fps},trim=duration=${esc(d)},setpts=PTS-STARTPTS${lk.pre}`
    // El fundido va despues del encuadre para que tambien afecte al fondo negro.
    lines.push(lk.frame ? `${head}${lk.frame}${vfade},format=yuv420p,setpts=PTS-STARTPTS[v${i}]` : `${head}${vfade},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`)
    if (c.hasAudio && c.volume > 0.001)
      lines.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${atempoChain(c.speed)}volume=${c.volume.toFixed(3)},atrim=0:${esc(d)},asetpts=PTS-STARTPTS${afade(fi, fo, d)}[a${i}]`)
    else lines.push(`anullsrc=r=48000:cl=stereo:d=${esc(d)},aformat=sample_fmts=fltp[a${i}]`)
  }
  lines.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vc][ac]`)
  let v = 'vc'
  const textBase = n
  textRanges.forEach((t, k) => {
    let src = `[${textBase + k}:v]`; let ox = '0'; let oy = '0'
    if (t.anim && t.anim !== 'none') {
      // Entrada y salida: fundido de la transparencia y (según la dirección) deslizamiento de ANIM_DIST px.
      const d = Math.max(0.05, Math.min(t.animDur ?? 0.4, (t.end - t.start) / 2))
      lines.push(`${src}format=rgba,fade=t=in:st=${esc(t.start)}:d=${esc(d)}:alpha=1,fade=t=out:st=${esc(t.end - d)}:d=${esc(d)}:alpha=1[ta${k}]`)
      src = `[ta${k}]`
      const dir: Record<string, [number, number]> = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }
      const [vx, vy] = dir[t.anim] ?? [0, 0]
      const off = `((1-clip((t-${esc(t.start)})/${esc(d)},0,1))-(1-clip((${esc(t.end)}-t)/${esc(d)},0,1)))`
      if (vx) ox = `${num(vx * ANIM_DIST)}*${off}`
      if (vy) oy = `${num(vy * ANIM_DIST)}*${off}`
    }
    lines.push(`[${v}]${src}overlay=x='${ox}':y='${oy}':format=auto:enable='between(t,${esc(t.start)},${esc(t.end)})'[vt${k}]`)
    v = `vt${k}`
  })
  const musicIdx = music ? textBase + textRanges.length : -1
  const audioBase = musicIdx >= 0 ? musicIdx + 1 : textBase + textRanges.length
  let a = 'ac'
  const mix: string[] = ['[ac]']
  if (music) {
    lines.push(`[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${music.volume.toFixed(2)},atrim=0:${esc(total)},afade=t=out:st=${esc(Math.max(0, total - 1))}:d=1,asetpts=PTS-STARTPTS[mu]`)
    mix.push('[mu]')
  }
  audios.forEach((x, k) => {
    const ms = Math.round(x.start * 1000)
    lines.push(`[${audioBase + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${esc(x.duration)},asetpts=PTS-STARTPTS,volume=${x.volume.toFixed(3)}${afade(Math.min(x.fadeIn, x.duration / 2), Math.min(x.fadeOut, x.duration / 2), x.duration)},adelay=${ms}|${ms}[au${k}]`)
    mix.push(`[au${k}]`)
  })
  if (mix.length > 1) {
    lines.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[am]`)
    a = 'am'
  }
  return { graph: lines.join(';\n'), vLabel: v, aLabel: a, textBase, musicIdx, audioBase, total }
}

export async function renderEditor(job: EditorRenderJob, encoder = 'libx264'): Promise<{ size: number; duration: number }> {
  const { clips } = job
  if (!clips.length) throw new Error('No hay clips en la línea de tiempo')
  mkdirSync(job.tmpDir, { recursive: true })
  const texts = job.texts.filter((t) => t.end > t.start)
  const textPaths = texts.map((t, k) => { const p = join(job.tmpDir, `text${k}.png`); writeFileSync(p, t.png); return p })
  const music = job.music && existsSync(job.music.path) ? job.music : null
  const audios = (job.audios ?? []).filter((x) => x.duration > 0 && existsSync(x.path))
  const f = buildEditorFilter(clips, texts, music, job.fps, audios)
  const scriptPath = join(job.tmpDir, 'graph.txt')
  writeFileSync(scriptPath, f.graph)

  const args = ['-y', '-hide_banner', '-v', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats']
  for (const c of clips) args.push('-ss', esc(c.srcStart), '-t', esc(c.srcEnd - c.srcStart + 0.1), '-i', c.path)
  for (const p of textPaths) args.push('-loop', '1', '-framerate', String(job.fps), '-t', esc(f.total), '-i', p)
  if (music) args.push('-stream_loop', '-1', '-i', music.path)
  for (const x of audios) args.push('-i', x.path)
  const settings = { fps: job.fps, quality: job.quality } as GenSettings
  args.push('-filter_complex_script', scriptPath, '-map', `[${f.vLabel}]`, '-map', `[${f.aLabel}]`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  args.push(...encoderArgs(settings, encoder), '-pix_fmt', 'yuv420p', '-r', String(job.fps), '-t', esc(f.total), '-movflags', '+faststart')
  const tmpOut = job.outPath + '.part.mp4'
  args.push(tmpOut)
  try {
    const r = await runFfmpeg(args, f.total, job)
    if (job.isCancelled()) throw new Error('Cancelado')
    if (r.code !== 0) {
      if (encoder !== 'libx264') return renderEditor(job, 'libx264') // el codificador por hardware falló: reintento por CPU
      throw new Error('FFmpeg falló: ' + (r.stderr.trim().split('\n').slice(-3).join(' ') || `código ${r.code}`))
    }
    renameSync(tmpOut, job.outPath)
    job.onProgress(1)
    return { size: statSync(job.outPath).size, duration: f.total }
  } finally {
    for (const p of [tmpOut, scriptPath, ...textPaths]) { try { rmSync(p, { force: true }) } catch { /* nada */ } }
  }
}

