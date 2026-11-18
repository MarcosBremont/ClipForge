package com.clipforge.android.text

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import com.clipforge.android.model.TextStyle
import kotlin.math.max

/**
 * Dibujado del texto. La MISMA función se usa para la vista previa (Canvas de Compose) y para el
 * bitmap que se superpone en la exportación, así que lo que se ve es lo que se exporta.
 */
object TextRenderer {
    const val W = 1080
    const val H = 1920

    private fun color(s: String, fallback: Int): Int = try { Color.parseColor(s) } catch (_: Exception) { fallback }

    private fun typeface(st: TextStyle): Typeface {
        val base = when (st.fontFamily) {
            "serif" -> Typeface.SERIF
            "monospace" -> Typeface.MONOSPACE
            "sans-serif-condensed" -> Typeface.create("sans-serif-condensed", Typeface.NORMAL)
            "sans-serif-black" -> Typeface.create("sans-serif-black", Typeface.NORMAL)
            "cursive" -> Typeface.create("cursive", Typeface.NORMAL)
            else -> Typeface.SANS_SERIF
        }
        return if (Build.VERSION.SDK_INT >= 28) Typeface.create(base, st.fontWeight, false)
        else Typeface.create(base, if (st.fontWeight >= 600) Typeface.BOLD else Typeface.NORMAL)
    }

    fun wrap(paint: Paint, text: String, maxW: Float): List<String> {
        val out = mutableListOf<String>()
        for (para in text.split(Regex("\r?\n"))) {
            val words = para.split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (words.isEmpty()) { out.add(""); continue }
            var line = words[0]
            for (i in 1 until words.size) {
                val t = line + " " + words[i]
                if (paint.measureText(t) <= maxW) line = t else { out.add(line); line = words[i] }
            }
            out.add(line)
        }
        return out
    }

    /** Dibuja el texto en un lienzo lógico de 1080×1920 escalado por [scale]. */
    fun draw(canvas: Canvas, text: String, st: TextStyle, scale: Float) {
        val content = if (st.uppercase) text.uppercase() else text
        if (content.isBlank()) return
        canvas.save()
        canvas.scale(scale, scale)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = typeface(st)
            textSize = st.fontSize
            textAlign = when (st.align) { "left" -> Paint.Align.LEFT; "right" -> Paint.Align.RIGHT; else -> Paint.Align.CENTER }
            strokeJoin = Paint.Join.ROUND
            strokeMiter = 2f
        }
        val maxW = st.maxWidth * W
        val lines = wrap(paint, content, maxW)
        val lh = st.fontSize * st.lineHeight
        val blockH = lh * lines.size
        val cx = st.x * W
        val anchorX = when (st.align) { "center" -> cx; "left" -> cx - maxW / 2; else -> cx + maxW / 2 }
        val fm = paint.fontMetrics
        val centerOffset = -(fm.ascent + fm.descent) / 2 // equivale a textBaseline = 'middle'
        var y = st.y * H - blockH / 2 + lh / 2
        for (line in lines) {
            if (st.outline && st.outlineWidth > 0) {
                paint.clearShadowLayer()
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = st.outlineWidth * 2
                paint.color = color(st.outlineColor, Color.BLACK)
                canvas.drawText(line, anchorX, y + centerOffset, paint)
            }
            paint.style = Paint.Style.FILL
            paint.strokeWidth = 0f
            if (st.shadow) paint.setShadowLayer(st.shadowBlur, 0f, max(2f, st.shadowBlur / 4), color(st.shadowColor, 0xBF000000.toInt()))
            else paint.clearShadowLayer()
            paint.color = color(st.color, Color.WHITE)
            canvas.drawText(line, anchorX, y + centerOffset, paint)
            y += lh
        }
        canvas.restore()
    }

    /** Recuadro (coordenadas del lienzo 1080×1920) que ocupa un texto: sirve para seleccionarlo y arrastrarlo en la vista previa. */
    fun measureBox(text: String, st: TextStyle): android.graphics.RectF {
        val content = if (st.uppercase) text.uppercase() else text
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = typeface(st); textSize = st.fontSize }
        val maxW = st.maxWidth * W
        val lines = wrap(paint, if (content.isBlank()) " " else content, maxW)
        val lh = st.fontSize * st.lineHeight
        val blockH = lh * lines.size
        val w = max(40f, lines.maxOf { paint.measureText(it) })
        val cx = st.x * W
        val anchorX = when (st.align) { "center" -> cx; "left" -> cx - maxW / 2; else -> cx + maxW / 2 }
        val left = when (st.align) { "center" -> anchorX - w / 2; "left" -> anchorX; else -> anchorX - w }
        val pad = (if (st.outline) st.outlineWidth else 0f) + 10f
        val top = st.y * H - blockH / 2 - pad
        return android.graphics.RectF(left - pad, top, left - pad + w + 2 * pad, top + blockH + 2 * pad)
    }

    /** Marca de agua propia del usuario (esquina inferior derecha). */
    fun drawWatermark(canvas: Canvas, text: String, scale: Float) {
        if (text.isBlank()) return
        canvas.save()
        canvas.scale(scale, scale)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            textSize = 40f
            textAlign = Paint.Align.RIGHT
            alpha = 191
            color = Color.argb(191, 255, 255, 255)
            setShadowLayer(8f, 0f, 2f, Color.argb(178, 0, 0, 0))
        }
        canvas.drawText(text, W - 44f, H - 150f, paint)
        canvas.restore()
    }

    /** Bitmap transparente 1080×1920 con texto (+ marca de agua) para superponer en el video, o null si no hay nada. */
    fun overlayBitmap(text: String, st: TextStyle, watermark: String): Bitmap? {
        if (text.isBlank() && watermark.isBlank()) return null
        val bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        draw(c, text, st, 1f)
        drawWatermark(c, watermark, 1f)
        return bmp
    }
}
