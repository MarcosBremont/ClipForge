// Exportación del editor de video (línea de tiempo): una sola llamada a FFmpeg.
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenSettings } from '@shared/types'
import { OUT_H, OUT_W, encoderArgs, esc, runFfmpeg } from './render'

export interface EdClip { path: string; srcStart: number; srcEnd: number; speed: number; volume: number; hasAudio: boolean }
export interface EdText { png: Buffer; start: number; end: number }
export interface EditorRenderJob {
  clips: EdClip[]
  texts: EdText[]
  music: { path: string; volume: number } | null
  fps: 30 | 60
  quality: 'alta' | 'media' | 'rapida'
  outPath: string
  tmpDir: string
  onProgress: (fraction: number) => void
  onSpawn: (p: ChildProcess) => void
  isCancelled: () => boolean
}

const clipDur = (c: EdClip): number => (c.srcEnd - c.srcStart) / c.speed

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
export function buildEditorFilter(clips: EdClip[], textRanges: Array<{ start: number; end: number }>, music: { volume: number } | null, fps: number): { graph: string; vLabel: string; aLabel: string; textBase: number; musicIdx: number; total: number } {
  const n = clips.length
  const total = clips.reduce((a, c) => a + clipDur(c), 0)
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const c = clips[i]
    const d = clipDur(c)
    lines.push(`[${i}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,setpts=(PTS-STARTPTS)/${c.speed.toFixed(4)},fps=${fps},trim=duration=${esc(d)},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`)
    if (c.hasAudio && c.volume > 0.001)
      lines.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${atempoChain(c.speed)}volume=${c.volume.toFixed(3)},atrim=0:${esc(d)},asetpts=PTS-STARTPTS[a${i}]`)
    else lines.push(`anullsrc=r=48000:cl=stereo:d=${esc(d)},aformat=sample_fmts=fltp[a${i}]`)
  }
  lines.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vc][ac]`)
  let v = 'vc'
  const textBase = n
  textRanges.forEach((t, k) => {
    lines.push(`[${v}][${textBase + k}:v]overlay=0:0:format=auto:enable='between(t,${esc(t.start)},${esc(t.end)})'[vt${k}]`)
    v = `vt${k}`
  })
  const musicIdx = music ? textBase + textRanges.length : -1
  let a = 'ac'
  if (music) {
    lines.push(`[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${music.volume.toFixed(2)},atrim=0:${esc(total)},afade=t=out:st=${esc(Math.max(0, total - 1))}:d=1,asetpts=PTS-STARTPTS[mu]`)
    lines.push('[ac][mu]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]')
    a = 'am'
  }
  return { graph: lines.join(';\n'), vLabel: v, aLabel: a, textBase, musicIdx, total }
}

export async function renderEditor(job: EditorRenderJob, encoder = 'libx264'): Promise<{ size: number; duration: number }> {
  const { clips } = job
  if (!clips.length) throw new Error('No hay clips en la línea de tiempo')
  mkdirSync(job.tmpDir, { recursive: true })
  const texts = job.texts.filter((t) => t.end > t.start)
  const textPaths = texts.map((t, k) => { const p = join(job.tmpDir, `text${k}.png`); writeFileSync(p, t.png); return p })
  const music = job.music && existsSync(job.music.path) ? job.music : null
  const f = buildEditorFilter(clips, texts, music, job.fps)
  const scriptPath = join(job.tmpDir, 'graph.txt')
  writeFileSync(scriptPath, f.graph)

  const args = ['-y', '-hide_banner', '-v', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats']
  for (const c of clips) args.push('-ss', esc(c.srcStart), '-t', esc(c.srcEnd - c.srcStart + 0.1), '-i', c.path)
  for (const p of textPaths) args.push('-loop', '1', '-framerate', String(job.fps), '-t', esc(f.total), '-i', p)
  if (music) args.push('-stream_loop', '-1', '-i', music.path)
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

