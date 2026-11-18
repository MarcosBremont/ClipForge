// Efectos de sonido incluidos: se sintetizan localmente (sin descargas ni derechos de autor) como WAV mono de 16 bits.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RATE = 44100
export interface SfxInfo { id: string; name: string; path: string; duration: number }

type Gen = (t: number, i: number, st: { lp: number; seed: number }) => number
const noise = (st: { seed: number }): number => { st.seed = (st.seed * 1664525 + 1013904223) >>> 0; return st.seed / 2147483648 - 1 }
const env = (t: number, d: number, a = 0.005): number => Math.min(1, t / a) * Math.max(0, 1 - t / d)

const DEFS: Array<{ id: string; name: string; dur: number; gen: Gen }> = [
  { id: 'pop', name: 'Pop', dur: 0.18, gen: (t) => Math.sin(2 * Math.PI * (900 - 3200 * t) * t) * env(t, 0.18, 0.002) * 0.9 },
  { id: 'ding', name: 'Ding', dur: 1.2, gen: (t) => (Math.sin(2 * Math.PI * 1318 * t) + 0.4 * Math.sin(2 * Math.PI * 2636 * t)) * Math.exp(-4 * t) * 0.5 * Math.min(1, t / 0.002) },
  { id: 'whoosh', name: 'Whoosh', dur: 0.9, gen: (t, _i, st) => { const f = 0.02 + 0.5 * Math.sin((Math.PI * t) / 0.9) ** 2; st.lp += f * (noise(st) - st.lp); return st.lp * 2.4 * Math.sin((Math.PI * t) / 0.9) } },
  { id: 'boom', name: 'Impacto', dur: 1.0, gen: (t, _i, st) => (Math.sin(2 * Math.PI * (70 - 40 * t) * t) * 0.9 + noise(st) * 0.25 * Math.exp(-14 * t)) * Math.exp(-3.5 * t) * Math.min(1, t / 0.002) },
  { id: 'click', name: 'Clic', dur: 0.06, gen: (t, _i, st) => noise(st) * Math.exp(-120 * t) * 0.8 },
  { id: 'riser', name: 'Subida', dur: 1.5, gen: (t) => Math.sin(2 * Math.PI * (250 + 900 * t) * t) * Math.min(1, t / 0.05) * Math.min(1, (1.5 - t) / 0.05) * 0.45 }
]

export function wavBytes(samples: Float32Array): Buffer {
  const data = samples.length * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(data, 40)
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  return b
}

/** Genera (si faltan) los efectos en `dir` y devuelve la lista. */
export function ensureSfx(dir: string): SfxInfo[] {
  mkdirSync(dir, { recursive: true })
  return DEFS.map((d) => {
    const path = join(dir, `${d.id}.wav`)
    if (!existsSync(path)) {
      const n = Math.round(d.dur * RATE)
      const out = new Float32Array(n)
      const st = { lp: 0, seed: 12345 }
      for (let i = 0; i < n; i++) out[i] = d.gen(i / RATE, i, st)
      writeFileSync(path, wavBytes(out))
    }
    return { id: d.id, name: d.name, path, duration: d.dur }
  })
}
