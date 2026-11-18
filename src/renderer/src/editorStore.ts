import { create } from 'zustand'
import type { VideoAsset } from '@shared/types'
import * as E from '@shared/editor'
import { api, type EditorRow } from './api'

export type Selection = { kind: 'clip' | 'text' | 'music' | 'audio'; id: string } | null
const HISTORY_LIMIT = 100

interface EditorState {
  project: E.EditorProject
  past: E.EditorProject[]
  future: E.EditorProject[]
  sel: Selection
  playhead: number
  playing: boolean
  seekTick: number // se incrementa cuando alguien pide un salto (la vista previa reposiciona los videos)
  pps: number // píxeles por segundo de la línea de tiempo
  videos: Record<number, VideoAsset>
  saveState: 'idle' | 'saving' | 'saved'
  // historial
  apply: (fn: (p: E.EditorProject) => E.EditorProject) => void
  beginGesture: () => void
  live: (fn: (p: E.EditorProject) => E.EditorProject) => void
  undo: () => void
  redo: () => void
  // estado
  select: (s: Selection) => void
  seek: (t: number) => void
  setPlaying: (v: boolean) => void
  setPlayhead: (t: number) => void
  setZoom: (pps: number) => void
  ensureVideos: (ids: number[]) => Promise<void>
  addVideo: (v: VideoAsset, atPlayhead?: boolean) => void
  newProject: () => void
  open: (row: EditorRow) => void
  load: (p: E.EditorProject) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
const empty = (): E.EditorProject => E.newProject()

export const useEditor = create<EditorState>((set, get) => {
  const scheduleSave = (): void => {
    set({ saveState: 'saving' })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const p = get().project
      if (!p.clips.length && !p.texts.length && p.id === null) { set({ saveState: 'idle' }); return }
      try {
        const id = await api.editorSave({ id: p.id, name: p.name, data: JSON.stringify(p) })
        if (get().project.id === null) set((s) => ({ project: { ...s.project, id } }))
        set({ saveState: 'saved' })
      } catch { set({ saveState: 'idle' }) }
    }, 800)
  }
  const commit = (p: E.EditorProject, push: boolean): void => {
    set((s) => ({
      project: p,
      past: push ? [...s.past.slice(-(HISTORY_LIMIT - 1)), s.project] : s.past,
      future: push ? [] : s.future
    }))
    scheduleSave()
  }
  /** Quita la selección si el elemento ya no existe. */
  const fixSel = (): void => {
    const { sel, project } = get()
    if (!sel) return
    const exists = sel.kind === 'clip' ? project.clips.some((c) => c.id === sel.id) : sel.kind === 'text' ? project.texts.some((t) => t.id === sel.id) : sel.kind === 'audio' ? (project.audios ?? []).some((a) => a.id === sel.id) : !!project.music
    if (!exists) set({ sel: null })
  }
  return {
    project: empty(), past: [], future: [], sel: null, playhead: 0, playing: false, seekTick: 0, pps: 70, videos: {}, saveState: 'idle',

    apply: (fn) => { const next = fn(get().project); if (next !== get().project) { commit(next, true); fixSel() } },
    beginGesture: () => set((s) => ({ past: [...s.past.slice(-(HISTORY_LIMIT - 1)), s.project], future: [] })),
    live: (fn) => { const next = fn(get().project); if (next !== get().project) commit(next, false) },
    undo: () => {
      const { past, project, future } = get()
      if (!past.length) return
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] })
      fixSel(); scheduleSave()
      set((s) => ({ seekTick: s.seekTick + 1 }))
    },
    redo: () => {
      const { past, project, future } = get()
      if (!future.length) return
      set({ project: future[0], past: [...past, project], future: future.slice(1) })
      fixSel(); scheduleSave()
      set((s) => ({ seekTick: s.seekTick + 1 }))
    },

    select: (sel) => set({ sel }),
    seek: (t) => set((s) => ({ playhead: Math.max(0, Math.min(t, E.totalDuration(s.project))), seekTick: s.seekTick + 1 })),
    setPlaying: (playing) => set({ playing }),
    setPlayhead: (playhead) => set({ playhead }),
    setZoom: (pps) => set({ pps: Math.max(12, Math.min(400, pps)) }),

    ensureVideos: async (ids) => {
      const need = ids.filter((id) => !get().videos[id])
      if (!need.length) return
      const vs = await api.getVideos(need)
      set((s) => { const m = { ...s.videos }; vs.forEach((v) => { m[v.id] = v }); return { videos: m } })
    },
    addVideo: (v, atPlayhead = false) => {
      set((s) => ({ videos: { ...s.videos, [v.id]: v } }))
      const { project, playhead } = get()
      let index = project.clips.length
      if (atPlayhead && project.clips.length) { const loc = E.locate(project, playhead); if (loc) index = loc.index + 1 }
      get().apply((p) => E.addClip(p, v.id, v.duration, index))
    },
    newProject: () => { if (saveTimer) clearTimeout(saveTimer); set({ project: empty(), past: [], future: [], sel: null, playhead: 0, playing: false, saveState: 'idle', seekTick: get().seekTick + 1 }) },
    load: (p) => {
      if (saveTimer) clearTimeout(saveTimer)
      set({ project: p, past: [], future: [], sel: null, playhead: 0, playing: false, saveState: 'idle', seekTick: get().seekTick + 1 })
      void get().ensureVideos([...new Set(p.clips.map((c) => c.videoId))])
    },
    open: (row) => {
      try { const p = JSON.parse(row.data) as E.EditorProject; get().load({ ...empty(), ...p, id: row.id, name: row.name }); set({ saveState: 'saved' }) } catch { /* proyecto dañado */ }
    }
  }
})
