import { safeStorage } from 'electron'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AIProviderId, AIProviderInfo } from '@shared/types'
import * as db from './db'
import { ffmpegPath, run } from './ffmpeg'

// Las claves NUNCA van en el código: se guardan cifradas con el almacén del sistema
// (DPAPI en Windows, Keychain en macOS) dentro de la base de datos local.

interface ProviderDef { id: AIProviderId; label: string; defaultModel: string; kind: 'openai' | 'gemini' | 'claude'; base: string }

const PROVIDERS: ProviderDef[] = [
  { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-2.5-flash', kind: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'google/gemini-2.5-flash', kind: 'openai', base: 'https://openrouter.ai/api/v1' },
  { id: 'grok', label: 'Grok (xAI)', defaultModel: 'grok-4', kind: 'openai', base: 'https://api.x.ai/v1' },
  { id: 'qwen', label: 'Qwen (Alibaba)', defaultModel: 'qwen-vl-plus', kind: 'openai', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { id: 'claude', label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-5-5', kind: 'claude', base: 'https://api.anthropic.com/v1' }
]

const def = (id: AIProviderId): ProviderDef => PROVIDERS.find((p) => p.id === id)!

export function setKey(id: AIProviderId, key: string): void {
  if (!key) { db.setSetting(`ai.key.${id}`, null); return }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('El sistema no ofrece almacenamiento cifrado de claves; no se guardará la clave.')
  db.setSetting(`ai.key.${id}`, safeStorage.encryptString(key).toString('base64'))
}

function getKey(id: AIProviderId): string | null {
  const v = db.getSetting<string | null>(`ai.key.${id}`, null)
  if (!v) return null
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')) } catch { return null }
}

export function setModel(id: AIProviderId, model: string): void { db.setSetting(`ai.model.${id}`, model || null) }

export function listProviders(): AIProviderInfo[] {
  const active = db.getSetting<AIProviderId | null>('ai.active', null)
  return PROVIDERS.map((p) => ({
    id: p.id, label: p.label, defaultModel: p.defaultModel,
    hasKey: !!db.getSetting<string | null>(`ai.key.${p.id}`, null),
    model: db.getSetting<string | null>(`ai.model.${p.id}`, null) ?? p.defaultModel,
    enabled: active === p.id
  }))
}

export function setActive(id: AIProviderId | null): void { db.setSetting('ai.active', id) }

export function activeProvider(): AIProviderId | null {
  const a = db.getSetting<AIProviderId | null>('ai.active', null)
  return a && getKey(a) ? a : null
}

interface ChatReq { system?: string; user: string; imagesB64?: string[]; json?: boolean }

async function http(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 300)
    try { const j = JSON.parse(text); msg = j.error?.message ?? j.error ?? j.message ?? msg } catch { /* texto plano */ }
    throw new Error(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
  }
  return JSON.parse(text)
}

export async function chat(id: AIProviderId, req: ChatReq): Promise<string> {
  const p = def(id)
  const key = getKey(id)
  if (!key) throw new Error(`Falta la API key de ${p.label}`)
  const model = db.getSetting<string | null>(`ai.model.${id}`, null) ?? p.defaultModel
  const imgs = req.imagesB64 ?? []
  if (p.kind === 'gemini') {
    const parts: unknown[] = [{ text: req.user }, ...imgs.map((d) => ({ inline_data: { mime_type: 'image/jpeg', data: d } }))]
    const body: Record<string, unknown> = { contents: [{ role: 'user', parts }] }
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
    if (req.json) body.generationConfig = { responseMimeType: 'application/json' }
    const j = (await http(`${p.base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body)
    })) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    return j.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') ?? ''
  }
  if (p.kind === 'claude') {
    const content: unknown[] = [...imgs.map((d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } })), { type: 'text', text: req.user }]
    const j = (await http(`${p.base}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system: req.system, messages: [{ role: 'user', content }] })
    })) as { content?: Array<{ type: string; text?: string }> }
    return j.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ?? ''
  }
  const content: unknown[] = [{ type: 'text', text: req.user }, ...imgs.map((d) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${d}` } }))]
  const messages: unknown[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  messages.push({ role: 'user', content: imgs.length ? content : req.user })
  const j = (await http(`${p.base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens: 1024 })
  })) as { choices?: Array<{ message?: { content?: string } }> }
  return j.choices?.[0]?.message?.content ?? ''
}

function extractJson<T>(text: string): T {
  const m = /[[{][\s\S]*[\]}]/.exec(text)
  if (!m) throw new Error('La IA no devolvió JSON válido')
  return JSON.parse(m[0]) as T
}

export async function testProvider(id: AIProviderId): Promise<string> {
  const r = await chat(id, { user: 'Responde únicamente con la palabra: ok' })
  return r.trim().slice(0, 80)
}

export async function suggestPhrases(id: AIProviderId, topic: string, count = 8): Promise<string[]> {
  const r = await chat(id, {
    system: 'Eres guionista de videos virales cortos (TikTok/Reels/Shorts) en español. Responde solo con un arreglo JSON de strings.',
    user: `Sugiere ${count} frases o preguntas cortas (máx. 12 palabras) que generen curiosidad o debate, para mostrar centradas sobre un video de escenas rápidas.${topic ? ` Tema o contexto: ${topic}.` : ''}`
  })
  return extractJson<string[]>(r).filter((x) => typeof x === 'string').slice(0, count)
}

/** Hoja de contacto de 4 fotogramas para que la IA valore el video. */
async function contactSheet(file: string, duration: number, tmp: string): Promise<string | null> {
  const times = [0.15, 0.4, 0.65, 0.9].map((f) => Math.max(0, duration * f))
  const out = join(tmp, `sheet-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`)
  const args = ['-y', '-v', 'error']
  for (const t of times) args.push('-ss', t.toFixed(2), '-i', file)
  args.push('-filter_complex', times.map((_, i) => `[${i}:v]scale=320:-2[s${i}]`).join(';') + ';' + times.map((_, i) => `[s${i}]`).join('') + `hstack=inputs=${times.length}`, '-frames:v', '1', '-q:v', '5', out)
  const r = await run(ffmpegPath(), args, { timeoutMs: 60000 })
  if (r.code !== 0) return null
  try { return readFileSync(out).toString('base64') } catch { return null } finally { try { rmSync(out, { force: true }) } catch { /* nada */ } }
}

export interface ScoredVideo { id: number; score: number; note?: string }

/** Puntúa videos (0..1) según su atractivo visual. Opcional: el editor funciona sin esto. */
export async function scoreVideo(id: AIProviderId, file: string, duration: number, tmpDir: string): Promise<{ score: number; note: string } | null> {
  const img = await contactSheet(file, duration, tmpDir)
  if (!img) return null
  const r = await chat(id, {
    system: 'Eres editor de videos virales verticales. Responde solo con un objeto JSON {"score":0-10,"note":"máx 10 palabras"}.',
    user: 'La imagen muestra 4 fotogramas de un video (de izquierda a derecha, en orden). Puntúa de 0 a 10 qué tan atractivo es visualmente para un video viral de cortes rápidos (acción, emoción, buena composición e iluminación = alto; pantalla negra, texto, borroso o aburrido = bajo).',
    imagesB64: [img]
  })
  const j = extractJson<{ score: number; note?: string }>(r)
  return { score: Math.max(0, Math.min(10, Number(j.score))) / 10, note: j.note ?? '' }
}
