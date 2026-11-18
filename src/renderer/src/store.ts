import { create } from 'zustand'
import {
  DEFAULT_GEN_SETTINGS, DEFAULT_TEXT_STYLE,
  type GenSettings, type JobProgress, type Plan, type Project, type TextStyle
} from '@shared/types'
import { api, type UpdateState } from './api'

export type Page = 'inicio' | 'biblioteca' | 'crear' | 'editor' | 'proyectos' | 'generados' | 'plantillas' | 'ia' | 'config'

export interface Draft {
  projectId: number | null
  name: string
  libraryId: number | null
  text: string
  style: TextStyle
  settings: GenSettings
  plan: Plan | null
}

const emptyDraft = (): Draft => ({ projectId: null, name: 'Proyecto sin título', libraryId: null, text: '', style: { ...DEFAULT_TEXT_STYLE }, settings: { ...DEFAULT_GEN_SETTINGS }, plan: null })

interface State {
  page: Page
  go: (p: Page) => void
  jobs: Record<string, JobProgress>
  libVersion: number // se incrementa cuando cambia la biblioteca (importaciones, etc.)
  bumpLib: () => void
  draft: Draft
  setDraft: (patch: Partial<Draft>) => void
  newDraft: () => void
  openProject: (p: Project) => void
  saveState: 'idle' | 'saving' | 'saved'
  toast: { msg: string; kind: 'ok' | 'err' } | null
  notify: (msg: string, kind?: 'ok' | 'err') => void
  dismissJob: (id: string) => void
  update: UpdateState
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<State>((set, get) => ({
  page: 'inicio',
  update: { status: 'idle' },
  go: (page) => set({ page }),
  jobs: {},
  libVersion: 0,
  bumpLib: () => set((s) => ({ libVersion: s.libVersion + 1 })),
  draft: emptyDraft(),
  saveState: 'idle',
  toast: null,
  notify: (msg, kind = 'ok') => {
    set({ toast: { msg, kind } })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: null }), kind === 'err' ? 8000 : 3500)
  },
  dismissJob: (id) => set((s) => { const j = { ...s.jobs }; delete j[id]; return { jobs: j } }),
  newDraft: () => set({ draft: emptyDraft(), saveState: 'idle' }),
  openProject: (p) => set({
    draft: { projectId: p.id, name: p.name, libraryId: p.library, text: p.text, style: p.style, settings: p.settings, plan: p.plan },
    page: 'crear', saveState: 'saved'
  }),
  setDraft: (patch) => {
    set((s) => ({ draft: { ...s.draft, ...patch }, saveState: 'saving' }))
    // Guardado automático con retardo: el proyecto se recupera tras cerrar la app.
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const d = get().draft
      if (!d.text.trim() && !d.plan && d.projectId === null) { set({ saveState: 'idle' }); return }
      try {
        const id = await api.saveProject({
          id: d.projectId ?? undefined, name: d.name || d.text.slice(0, 40) || 'Proyecto sin título',
          library: d.libraryId, text: d.text, style: d.style, settings: d.settings, plan: d.plan
        })
        set((s) => ({ draft: { ...s.draft, projectId: id }, saveState: 'saved' }))
      } catch { set({ saveState: 'idle' }) }
    }, 700)
  }
}))

export function initUpdateListener(): () => void {
  void api.updateState().then((update) => useStore.setState({ update }))
  return window.api.onUpdate((s) => useStore.setState({ update: s as UpdateState }))
}

export function initJobListener(): () => void {
  return window.api.onJob((p) => {
    useStore.setState((s) => ({ jobs: { ...s.jobs, [p.jobId]: p } }))
    if (p.status !== 'running') {
      useStore.getState().bumpLib()
      if (p.status !== 'error' && !p.message) setTimeout(() => useStore.getState().dismissJob(p.jobId), 6000)
      if (p.kind === 'import' && p.status === 'done') {
        const r = p.result as { added: number; duplicates: number; failed: unknown[] } | undefined
        if (r && r.added !== undefined && !(r as { subJob?: string }).subJob) {
          useStore.getState().notify(`${r.added} videos importados${r.duplicates ? ` (${r.duplicates} duplicados detectados)` : ''}${r.failed.length ? `, ${r.failed.length} con error` : ''}`, r.failed.length && !r.added ? 'err' : 'ok')
        }
      }
    }
  })
}
