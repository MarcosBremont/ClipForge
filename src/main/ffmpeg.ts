import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

function unpacked(p: string): string {
  return p.replace('app.asar' + (process.platform === 'win32' ? '\\' : '/'), 'app.asar.unpacked' + (process.platform === 'win32' ? '\\' : '/'))
}

let _ffmpeg: string | null = null
let _ffprobe: string | null = null

export function ffmpegPath(): string {
  if (_ffmpeg) return _ffmpeg
  if (process.env.CLIPFORGE_FFMPEG) return (_ffmpeg = process.env.CLIPFORGE_FFMPEG)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = unpacked(require('ffmpeg-static') as string)
    if (p && existsSync(p)) return (_ffmpeg = p)
  } catch { /* usar el del sistema */ }
  return (_ffmpeg = 'ffmpeg')
}

export function ffprobePath(): string {
  if (_ffprobe) return _ffprobe
  if (process.env.CLIPFORGE_FFPROBE) return (_ffprobe = process.env.CLIPFORGE_FFPROBE)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = unpacked((require('ffprobe-static') as { path: string }).path)
    if (p && existsSync(p)) return (_ffprobe = p)
  } catch { /* usar el del sistema */ }
  return (_ffprobe = 'ffprobe')
}

export interface RunResult { code: number; stdout: string; stderr: string }

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; onSpawn?: (p: ChildProcess) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true })
    opts.onSpawn?.(p)
    let stdout = ''
    let stderr = ''
    p.stdout?.on('data', (d) => { stdout += d })
    p.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-20000) })
    const timer = opts.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs) : null
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e) })
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

export interface ProbeInfo {
  duration: number
  width: number
  height: number
  fps: number
  codec: string
  format: string
  hasAudio: boolean
}

export async function probe(file: string): Promise<ProbeInfo> {
  const r = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 })
  if (r.code !== 0) throw new Error('ffprobe falló: ' + r.stderr.trim().split('\n').pop())
  const j = JSON.parse(r.stdout) as {
    format?: { duration?: string; format_name?: string }
    streams?: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string; side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string } }>
  }
  const v = j.streams?.find((s) => s.codec_type === 'video' && s.width)
  if (!v) throw new Error('El archivo no contiene video')
  let w = v.width ?? 0
  let h = v.height ?? 0
  const rot = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0))
  if (rot === 90 || rot === 270) [w, h] = [h, w]
  const [n, d] = (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate ?? '0/1').split('/').map(Number)
  const fps = d ? n / d : 0
  const duration = Number(j.format?.duration ?? v.duration ?? 0)
  if (!isFinite(duration) || duration <= 0) throw new Error('Duración no válida')
  return {
    duration,
    width: w,
    height: h,
    fps: Math.round(fps * 100) / 100,
    codec: v.codec_name,
    format: (j.format?.format_name ?? '').split(',')[0],
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio')
  }
}

export async function makeThumbnail(file: string, out: string, duration: number): Promise<boolean> {
  const t = Math.max(0, Math.min(duration * 0.25, duration - 0.1))
  const r = await run(ffmpegPath(), ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', out], { timeoutMs: 60000 })
  return r.code === 0 && existsSync(out)
}

/** Detecta cambios de escena de forma local con FFmpeg (sin IA). */
export async function detectScenes(file: string, threshold = 0.32): Promise<number[]> {
  const r = await run(ffmpegPath(), ['-v', 'info', '-i', file, '-vf', `scale=160:-2,select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], { timeoutMs: 10 * 60 * 1000 })
  const out: number[] = []
  for (const m of r.stderr.matchAll(/pts_time:([0-9.]+)/g)) out.push(Number(m[1]))
  return out
}
