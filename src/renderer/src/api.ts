import type * as E from '@shared/editor'
import type {
  AIProviderId, AIProviderInfo, AppSettings, DashboardStats, GeneratedVideo, GenSettings, JobProgress, Library, Plan,
  Project, TextStyle, TextTemplate, VideoAsset
} from '@shared/types'

declare global {
  interface Window {
    api: {
      invoke: (ch: string, ...a: unknown[]) => Promise<never>
      pathForFile: (f: File) => string
      onJob: (cb: (p: JobProgress) => void) => () => void
      onUpdate: (cb: (s: unknown) => void) => () => void
    }
  }
}

const inv = <T>(ch: string, ...a: unknown[]): Promise<T> => window.api.invoke(ch, ...a) as Promise<T>

export interface RenderRequest {
  projectId: number | null
  libraryId: number
  text: string
  style: TextStyle
  settings: GenSettings
  textPng: Uint8Array | null
  watermarkPng: Uint8Array | null
  plan: Plan | null
}

export interface EditorExportRequest {
  name: string
  clips: Array<Pick<E.EClip, 'videoId' | 'srcStart' | 'srcEnd' | 'speed' | 'volume' | 'fadeIn' | 'fadeOut' | 'bright' | 'contrast' | 'sat' | 'warmth' | 'scale' | 'rot' | 'flip' | 'px' | 'py' | 'kScale' | 'kPx' | 'kPy'>>
  texts: Array<{ png: Uint8Array; start: number; end: number; anim?: string; animDur?: number }>
  music: { path: string; volume: number } | null
  audios: Array<{ path: string; start: number; duration: number; volume: number; fadeIn: number; fadeOut: number }>
  fps: 30 | 60
  quality: 'alta' | 'media' | 'rapida'
}
export interface EditorRow { id: number; name: string; data: string; updatedAt: number }

export type OutputRow = GeneratedVideo & { exists: boolean }

export type UpdateState =
  | { status: 'idle' } | { status: 'unavailable'; message: string } | { status: 'checking' } | { status: 'none' }
  | { status: 'available'; version: string; notes: string } | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string } | { status: 'error'; message: string }

export const api = {
  version: () => inv<string>('app:version'),
  updateState: () => inv<UpdateState>('update:state'),
  updateCheck: () => inv<UpdateState>('update:check'),
  updateDownload: () => inv<void>('update:download'),
  updateInstall: () => inv<void>('update:install'),
  settings: () => inv<AppSettings>('app:settings'),
  setOutputDir: (d: string) => inv<void>('app:setOutputDir', d),
  setHwAccel: (v: boolean) => inv<void>('app:setHwAccel', v),
  hwEncoders: () => inv<string[]>('app:hwEncoders'),
  stats: () => inv<DashboardStats>('app:stats'),

  pickFolders: () => inv<string[]>('dialog:folder'),
  pickVideos: () => inv<string[]>('dialog:videos'),
  pickMusic: () => inv<string | null>('dialog:music'),
  sfxList: () => inv<Array<{ id: string; name: string; path: string; duration: number }>>('sfx:list'),
  voiceSave: (bytes: Uint8Array) => inv<string>('voice:save', bytes),
  pickOutputDir: () => inv<string | null>('dialog:outputDir'),

  libraries: () => inv<Library[]>('lib:list'),
  createLibrary: (name: string) => inv<number>('lib:create', name),
  renameLibrary: (id: number, name: string) => inv<void>('lib:rename', id, name),
  deleteLibrary: (id: number) => inv<void>('lib:delete', id),
  videos: (id: number, opts: { search?: string; limit?: number; offset?: number }) => inv<{ items: VideoAsset[]; total: number }>('lib:videos', id, opts),
  importPaths: (id: number, paths: string[]) => inv<string>('lib:import', id, paths),
  importUrl: (id: number, url: string) => inv<string>('lib:importUrl', id, url),
  verifyLibrary: (id: number) => inv<{ missing: number; restored: number }>('lib:verify', id),
  removeVideo: (id: number) => inv<void>('lib:removeVideo', id),
  analyzeScenes: (id: number) => inv<string>('lib:analyzeScenes', id),
  analyzeAI: (id: number, limit: number) => inv<string>('lib:analyzeAI', id, limit),
  getVideos: (ids: number[]) => inv<VideoAsset[]>('video:getMany', ids),
  proxy: (id: number) => inv<string>('video:proxy', id),

  planMake: (lib: number, s: GenSettings) => inv<Plan>('plan:make', lib, s),
  planRegen: (lib: number, s: GenSettings, prev: Plan | null) => inv<Plan>('plan:regen', lib, s, prev),
  planReplace: (lib: number, s: GenSettings, plan: Plan, i: number) => inv<Plan>('plan:replace', lib, s, plan, i),
  planPick: (lib: number, s: GenSettings, plan: Plan, videoId: number, i: number | null) => inv<Plan>('plan:pick', lib, s, plan, videoId, i),

  render: (req: RenderRequest) => inv<string>('render:start', req),
  editorExport: (req: EditorExportRequest) => inv<string>('editor:export', req),
  editorList: () => inv<EditorRow[]>('editor:list'),
  editorGet: (id: number) => inv<EditorRow | null>('editor:get', id),
  editorSave: (p: { id?: number | null; name: string; data: string }) => inv<number>('editor:save', p),
  editorDelete: (id: number) => inv<void>('editor:delete', id),
  cancelJob: (id: string) => inv<void>('job:cancel', id),

  projects: () => inv<Project[]>('project:list'),
  getProject: (id: number) => inv<Project | null>('project:get', id),
  saveProject: (p: Partial<Project> & { name: string }) => inv<number>('project:save', p),
  deleteProject: (id: number) => inv<void>('project:delete', id),

  outputs: () => inv<OutputRow[]>('output:list'),
  deleteOutput: (id: number, file: boolean) => inv<void>('output:delete', id, file),
  reveal: (p: string) => inv<void>('output:reveal', p),
  openFile: (p: string) => inv<string>('output:open', p),
  clearHistory: () => inv<void>('history:clear'),

  templates: () => inv<TextTemplate[]>('template:list'),
  saveTemplate: (name: string, s: TextStyle) => inv<number>('template:save', name, s),
  deleteTemplate: (id: number) => inv<void>('template:delete', id),

  providers: () => inv<AIProviderInfo[]>('ai:providers'),
  setKey: (id: AIProviderId, key: string) => inv<void>('ai:setKey', id, key),
  setModel: (id: AIProviderId, m: string) => inv<void>('ai:setModel', id, m),
  setActive: (id: AIProviderId | null) => inv<void>('ai:setActive', id),
  testProvider: (id: AIProviderId) => inv<string>('ai:test', id),
  suggest: (topic: string) => inv<string[]>('ai:suggest', topic)
}

export const mediaUrl = (p: string): string => `media://local/${encodeURIComponent(p)}`

export const fmtTime = (s: number): string => {
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(1).padStart(4, '0')}`
}
export const fmtDur = (s: number): string => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h} h ${m} min` : m ? `${m} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`
}
export const fmtSize = (b: number): string => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`)
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
