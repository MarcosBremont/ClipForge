// Tipos compartidos entre proceso principal, preload e interfaz.

export interface VideoAsset {
  id: number
  path: string
  name: string
  folder: string
  duration: number // segundos
  width: number
  height: number
  fps: number
  codec: string
  format: string
  size: number // bytes
  hasAudio: boolean
  hash: string
  thumb: string | null // ruta absoluta a la miniatura
  dupOf: number | null // id del original si es duplicado
  missing: boolean
  libraryId: number
  addedAt: number
  scenes: number[] | null // instantes (s) de cambio de escena, si se analizaron
}

export interface Library {
  id: number
  name: string
  roots: string[]
  createdAt: number
  videoCount: number
  duplicateCount: number
  totalSize: number
  totalDuration: number
}

export interface TextStyle {
  fontFamily: string
  fontSize: number // px sobre un lienzo de 1080 de ancho
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  x: number // 0..1 centro del bloque
  y: number // 0..1
  maxWidth: number // 0..1 ancho del bloque respecto al lienzo
  shadow: boolean
  shadowBlur: number
  shadowColor: string
  outline: boolean
  outlineWidth: number
  outlineColor: string
  lineHeight: number
  uppercase: boolean
  startAt: number // s
  endAt: number | null // null = hasta el final
  wholeVideo: boolean
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Arial',
  fontSize: 76,
  fontWeight: 700,
  color: '#ffffff',
  align: 'center',
  x: 0.5,
  y: 0.5,
  maxWidth: 0.86,
  shadow: true,
  shadowBlur: 10,
  shadowColor: 'rgba(0,0,0,0.75)',
  outline: true,
  outlineWidth: 6,
  outlineColor: '#000000',
  lineHeight: 1.18,
  uppercase: false,
  startAt: 0,
  endAt: null,
  wholeVideo: true
}

export interface TextTemplate {
  id: number
  name: string
  style: TextStyle
}

export type CutSpeed = 'lento' | 'normal' | 'rapido'

export interface GenSettings {
  duration: number // 10..60
  auto: boolean
  segmentCount: number | null // null = automático
  segmentLength: number | null // s aproximados, null = automático
  speed: CutSpeed
  fps: 30 | 60
  quality: 'alta' | 'media' | 'rapida'
  originalAudio: boolean
  musicPath: string | null
  musicVolume: number // 0..1
  versions: number
  watermark: string // texto de marca de agua propia (vacío = ninguna)
  useAI: boolean
}

export const DEFAULT_GEN_SETTINGS: GenSettings = {
  duration: 15,
  auto: true,
  segmentCount: null,
  segmentLength: null,
  speed: 'normal',
  fps: 30,
  quality: 'media',
  originalAudio: false,
  musicPath: null,
  musicVolume: 0.8,
  versions: 1,
  watermark: '',
  useAI: false
}

export interface Segment {
  uid: string
  videoId: number
  start: number // s dentro del video fuente
  duration: number // s
}

export interface Plan {
  segments: Segment[]
  seed: number
}

export interface Project {
  id: number
  name: string
  library: number | null
  text: string
  style: TextStyle
  settings: GenSettings
  plan: Plan | null
  createdAt: number
  updatedAt: number
}

export interface GeneratedVideo {
  id: number
  projectId: number | null
  path: string
  text: string
  duration: number
  size: number
  createdAt: number
}

export type AIProviderId = 'gemini' | 'openrouter' | 'grok' | 'qwen' | 'claude'

export interface AIProviderInfo {
  id: AIProviderId
  label: string
  defaultModel: string
  hasKey: boolean
  model: string
  enabled: boolean
}

export interface AppSettings {
  outputDir: string
  activeProvider: AIProviderId | null
  hwAccel: boolean
}

export interface JobProgress {
  jobId: string
  kind: 'import' | 'render' | 'analyze'
  label: string
  done: number
  total: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  message?: string
  result?: unknown
}

export interface DashboardStats {
  videos: number
  libraries: number
  generated: number
  recentProjects: Project[]
}

export const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.3gp'
]
