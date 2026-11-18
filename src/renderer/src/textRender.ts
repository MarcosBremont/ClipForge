import type { TextStyle } from '@shared/types'

export const CANVAS_W = 1080
export const CANVAS_H = 1920

function wrap(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) { out.push(''); continue }
    let line = words[0]
    for (let i = 1; i < words.length; i++) {
      const t = line + ' ' + words[i]
      if (ctx.measureText(t).width <= maxW) line = t
      else { out.push(line); line = words[i] }
    }
    out.push(line)
  }
  return out
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Dibuja el texto sobre un contexto con lienzo lógico de 1080×1920, escalado a `scale`. */
export function drawText(ctx: Ctx, text: string, st: TextStyle, scale: number): void {
  const content = st.uppercase ? text.toUpperCase() : text
  if (!content.trim()) return
  ctx.save()
  ctx.scale(scale, scale)
  ctx.font = `${st.fontWeight} ${st.fontSize}px "${st.fontFamily}", sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = st.align
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  const maxW = st.maxWidth * CANVAS_W
  const lines = wrap(ctx, content, maxW)
  const lh = st.fontSize * st.lineHeight
  const blockH = lh * lines.length
  const cx = st.x * CANVAS_W
  const anchorX = st.align === 'center' ? cx : st.align === 'left' ? cx - maxW / 2 : cx + maxW / 2
  let y = st.y * CANVAS_H - blockH / 2 + lh / 2
  for (const line of lines) {
    if (st.outline && st.outlineWidth > 0) {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.lineWidth = st.outlineWidth * 2
      ctx.strokeStyle = st.outlineColor
      ctx.strokeText(line, anchorX, y)
    }
    if (st.shadow) {
      ctx.shadowColor = st.shadowColor
      ctx.shadowBlur = st.shadowBlur
      ctx.shadowOffsetY = Math.max(2, st.shadowBlur / 4)
    } else { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0 }
    ctx.fillStyle = st.color
    ctx.fillText(line, anchorX, y)
    y += lh
  }
  ctx.restore()
}

/** Recuadro (en coordenadas del lienzo 1080×1920) que ocupa un texto: sirve para seleccionarlo y arrastrarlo en la vista previa. */
export function measureBox(text: string, st: TextStyle): { x: number; y: number; w: number; h: number } {
  const content = st.uppercase ? text.toUpperCase() : text
  const ctx = new OffscreenCanvas(8, 8).getContext('2d')!
  ctx.font = `${st.fontWeight} ${st.fontSize}px "${st.fontFamily}", sans-serif`
  const maxW = st.maxWidth * CANVAS_W
  const lines = wrap(ctx, content.trim() ? content : ' ', maxW)
  const lh = st.fontSize * st.lineHeight
  const blockH = lh * lines.length
  const w = Math.max(40, ...lines.map((l) => ctx.measureText(l).width))
  const cx = st.x * CANVAS_W
  const anchorX = st.align === 'center' ? cx : st.align === 'left' ? cx - maxW / 2 : cx + maxW / 2
  const left = st.align === 'center' ? anchorX - w / 2 : st.align === 'left' ? anchorX : anchorX - w
  const pad = (st.outline ? st.outlineWidth : 0) + 10
  return { x: left - pad, y: st.y * CANVAS_H - blockH / 2 - pad, w: w + 2 * pad, h: blockH + 2 * pad }
}

async function toPng(draw: (ctx: OffscreenCanvasRenderingContext2D) => void): Promise<Uint8Array> {
  await document.fonts.ready
  const c = new OffscreenCanvas(CANVAS_W, CANVAS_H)
  const ctx = c.getContext('2d')!
  draw(ctx)
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

export async function textOverlayPng(text: string, st: TextStyle): Promise<Uint8Array | null> {
  if (!text.trim()) return null
  return toPng((ctx) => drawText(ctx, text, st, 1))
}

/** Marca de agua propia del usuario (esquina inferior derecha). */
export function drawWatermark(ctx: Ctx, text: string, scale: number): void {
  if (!text.trim()) return
  ctx.save()
  ctx.scale(scale, scale)
  ctx.font = '600 40px Arial, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.globalAlpha = 0.75
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 8
  ctx.fillStyle = '#fff'
  ctx.fillText(text, CANVAS_W - 44, CANVAS_H - 150)
  ctx.restore()
}

export async function watermarkPng(text: string): Promise<Uint8Array | null> {
  if (!text.trim()) return null
  return toPng((ctx) => drawWatermark(ctx, text, 1))
}

export const COMMON_FONTS = ['Arial', 'Helvetica', 'Segoe UI', 'Impact', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Arial Black', 'Calibri', 'Comic Sans MS', 'SF Pro Display', 'Montserrat', 'Poppins', 'Roboto', 'Open Sans']

export async function listFonts(): Promise<string[]> {
  try {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts
    if (q) {
      const fams = [...new Set((await q.call(window)).map((f) => f.family))].sort((a, b) => a.localeCompare(b))
      if (fams.length) return fams
    }
  } catch { /* sin permiso: lista básica */ }
  return COMMON_FONTS
}
