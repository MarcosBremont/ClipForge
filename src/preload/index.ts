import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { JobProgress } from '@shared/types'

const call = (ch: string, ...a: unknown[]): Promise<never> => ipcRenderer.invoke(ch, ...a) as Promise<never>

const api = {
  invoke: call,
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  onUpdate: (cb: (s: unknown) => void): (() => void) => {
    const fn = (_: unknown, s: unknown): void => cb(s)
    ipcRenderer.on('update:state', fn)
    return () => ipcRenderer.removeListener('update:state', fn)
  },
  onJob: (cb: (p: JobProgress) => void): (() => void) => {
    const fn = (_: unknown, p: JobProgress): void => cb(p)
    ipcRenderer.on('job:progress', fn)
    return () => ipcRenderer.removeListener('job:progress', fn)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
