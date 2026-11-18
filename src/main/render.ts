import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenSettings, TextStyle, VideoAsset } from '@shared/types'
import { ffmpegPath, run } from './ffmpeg'

export const OUT_W = 1080
export const OUT_H = 1920

export interface RenderSegment { path: string; start: number; duration: number; hasAudio: boolean }

export interface RenderJob {
  segments: RenderSegment[]
  settings: GenSettings
  style: TextStyle
  textPng: Buffer | null
  watermarkPng: Buffer | null
  outPath: string
  tmpDir: string
  onProgress: (fraction: number) => void
  onSpawn: (p: import('node:child_process').ChildProcess) => void
  isCancelled: () => boolean
}

let encodersCache: string[] | null = null
export async function availableHwEncoders(): Promise<string[]> {
  if (encodersCache) return encodersCache
  const r = await run(ffmpegPath(), ['-hide_banner', '-encoders'])
  const names = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']
  encodersCache = names.filter((n) => r.stdout.includes(n))
  return encodersCache
}

export function esc(n: number): string { return n.toFixed(3) }

/** Construye el filter_complex. Exportado para pruebas. */
export function buildFilter(job: Pick<RenderJob, 'segments' | 'settings' | 'style'> & { hasText: boolean; hasWm: boolean; hasMusic: boolean }): { graph: string; vLabel: string; aLabel: string | null; textIdx: number; wmIdx: number; musicIdx: number } {
  const { segments: segs, settings: s } = job
  const n = segs.length
  const total = segs.reduce((a, b) => a + b.duration, 0)
  const keepAudio = s.originalAudio
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(`[${i}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${s.fps},trim=duration=${esc(segs[i].duration)},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`)
    if (keepAudio) {
      if (segs[i].hasAudio) lines.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${esc(segs[i].duration)},asetpts=PTS-STARTPTS[a${i}]`)
      else lines.push(`anullsrc=r=48000:cl=stereo:d=${esc(segs[i].duration)},aformat=sample_fmts=fltp[a${i}]`)
    }
  }
  const cat = segs.map((_, i) => `[v${i}]${keepAudio ? `[a${i}]` : ''}`).join('')
  lines.push(`${cat}concat=n=${n}:v=1:a=${keepAudio ? 1 : 0}[vc]${keepAudio ? '[ac]' : ''}`)
  let idx = n
  let v = 'vc'
  const textIdx = job.hasText ? idx++ : -1
  const wmIdx = job.hasWm ? idx++ : -1
  const musicIdx = job.hasMusic ? idx++ : -1
  if (textIdx >= 0) {
    const st = job.style
    const enable = st.wholeVideo ? '' : `:enable='between(t,${esc(st.startAt)},${esc(st.endAt ?? total)})'`
    lines.push(`[${v}][${textIdx}:v]overlay=0:0:format=auto${enable}[vt]`)
    v = 'vt'
  }
  if (wmIdx >= 0) {
    lines.push(`[${v}][${wmIdx}:v]overlay=0:0:format=auto[vw]`)
    v = 'vw'
  }
  let aLabel: string | null = keepAudio ? 'ac' : null
  if (musicIdx >= 0) {
    const fadeStart = Math.max(0, total - 1)
    lines.push(`[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${s.musicVolume.toFixed(2)},atrim=0:${esc(total)},afade=t=out:st=${esc(fadeStart)}:d=1,asetpts=PTS-STARTPTS[mu]`)
    if (keepAudio) { lines.push(`[ac][mu]amix=inputs=2:duration=first:dropout_transition=0[am]`); aLabel = 'am' } else aLabel = 'mu'
  }
  return { graph: lines.join(';\n'), vLabel: v, aLabel, textIdx, wmIdx, musicIdx }
}

export function encoderArgs(settings: GenSettings, encoder: string): string[] {
  const crf = settings.quality === 'alta' ? 18 : settings.quality === 'media' ? 22 : 26
  const preset = settings.quality === 'alta' ? 'medium' : settings.quality === 'media' ? 'fast' : 'veryfast'
  switch (encoder) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', String(crf + 2), '-b:v', '0']
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-global_quality', String(crf + 2)]
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'balanced', '-qp_i', String(crf + 2), '-qp_p', String(crf + 2)]
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-q:v', String(settings.quality === 'alta' ? 75 : settings.quality === 'media' ? 62 : 50)]
    default: return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high']
  }
}

export function runFfmpeg(args: string[], total: number, job: Pick<RenderJob, 'onSpawn' | 'onProgress'>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true })
    job.onSpawn(p)
    let stderr = ''
    let buf = ''
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(l)
        if (m) job.onProgress(Math.min(0.99, Number(m[1]) / 1e6 / total))
      }
    })
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000) })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

export async function renderVideo(job: RenderJob, encoder = 'libx264'): Promise<{ size: number; duration: number }> {
  const { segments, settings } = job
  if (!segments.length) throw new Error('No hay fragmentos para exportar')
  mkdirSync(job.tmpDir, { recursive: true })
  const total = segments.reduce((a, b) => a + b.duration, 0)
  const textPath = job.textPng ? join(job.tmpDir, 'text.png') : null
  const wmPath = job.watermarkPng ? join(job.tmpDir, 'wm.png') : null
  if (textPath) writeFileSync(textPath, job.textPng!)
  if (wmPath) writeFileSync(wmPath, job.watermarkPng!)
  const hasMusic = !!settings.musicPath && existsSync(settings.musicPath)

  const f = buildFilter({ segments, settings, style: job.style, hasText: !!textPath, hasWm: !!wmPath, hasMusic })
  const scriptPath = join(job.tmpDir, 'graph.txt')
  writeFileSync(scriptPath, f.graph)

  const args = ['-y', '-hide_banner', '-v', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats']
  for (const s of segments) args.push('-ss', esc(s.start), '-t', esc(s.duration + 0.05), '-i', s.path)
  if (textPath) args.push('-loop', '1', '-framerate', String(settings.fps), '-t', esc(total), '-i', textPath)
  if (wmPath) args.push('-loop', '1', '-framerate', String(settings.fps), '-t', esc(total), '-i', wmPath)
  if (hasMusic) args.push('-stream_loop', '-1', '-i', settings.musicPath!)
  args.push('-filter_complex_script', scriptPath, '-map', `[${f.vLabel}]`)
  if (f.aLabel) args.push('-map', `[${f.aLabel}]`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  else args.push('-an')
  args.push(...encoderArgs(settings, encoder), '-pix_fmt', 'yuv420p', '-r', String(settings.fps), '-t', esc(total), '-movflags', '+faststart')
  const tmpOut = job.outPath + '.part.mp4'
  args.push(tmpOut)

  try {
    const r = await runFfmpeg(args, total, job)
    if (job.isCancelled()) throw new Error('Cancelado')
    if (r.code !== 0) {
      if (encoder !== 'libx264') return renderVideo(job, 'libx264') // el codificador por hardware falló: reintento por CPU
      throw new Error('FFmpeg falló: ' + (r.stderr.trim().split('\n').slice(-3).join(' ') || `código ${r.code}`))
    }
    renameSync(tmpOut, job.outPath)
    job.onProgress(1)
    return { size: statSync(job.outPath).size, duration: total }
  } finally {
    for (const p of [tmpOut, textPath, wmPath, scriptPath]) if (p) { try { rmSync(p, { force: true }) } catch { /* nada */ } }
  }
}

/** Proxy ligero para previsualizar formatos que Chromium no reproduce (MKV, AVI, HEVC…). */
export async function makeProxy(v: VideoAsset, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `${v.hash}.mp4`)
  if (existsSync(out)) return out
  const tmp = out + '.part.mp4'
  const r = await run(ffmpegPath(), ['-y', '-v', 'error', '-i', v.path, '-vf', 'scale=-2:540,fps=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '15', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp], { timeoutMs: 30 * 60 * 1000 })
  if (r.code !== 0) throw new Error('No se pudo crear el proxy: ' + r.stderr.trim().split('\n').pop())
  renameSync(tmp, out)
  return out
}
