import { BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { JobProgress } from '@shared/types'

interface JobCtl { cancelled: boolean; procs: Set<ChildProcess> }
const jobs = new Map<string, JobCtl>()
let counter = 0

export function newJob(prefix: string): { id: string; ctl: JobCtl } {
  const id = `${prefix}-${Date.now()}-${++counter}`
  const ctl: JobCtl = { cancelled: false, procs: new Set() }
  jobs.set(id, ctl)
  return { id, ctl }
}

export function cancelJob(id: string): void {
  const j = jobs.get(id)
  if (!j) return
  j.cancelled = true
  for (const p of j.procs) { try { p.kill() } catch { /* ya terminó */ } }
}

export function endJob(id: string): void { jobs.delete(id) }

const lastSent = new Map<string, number>()
export function emitProgress(p: JobProgress): void {
  const now = Date.now()
  if (p.status === 'running') {
    if (now - (lastSent.get(p.jobId) ?? 0) < 120) return
    lastSent.set(p.jobId, now)
  } else lastSent.delete(p.jobId)
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('job:progress', p)
}

/** Ejecuta tareas con concurrencia limitada. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>, isCancelled: () => boolean): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length && !isCancelled()) {
      const idx = i++
      await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
