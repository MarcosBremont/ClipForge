package com.clipforge.android.editor

import com.clipforge.android.model.Segment
import com.clipforge.android.model.TextStyle
import kotlinx.serialization.Serializable
import kotlin.math.max
import kotlin.math.min

// Modelo del editor de video (línea de tiempo). Lógica pura, sin Android, para poder probarla en la JVM.
// Mismas reglas que src/shared/editor.ts de la versión de escritorio.

const val MIN_CLIP = 0.3 // s de línea de tiempo
const val MIN_TEXT = 0.3
val SPEEDS = listOf(0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0)

/** Un tramo de un video de la biblioteca. Dura (srcEnd - srcStart) / speed en la línea de tiempo. */
@Serializable
data class EClip(
    val id: String, val videoId: Long, val srcStart: Double, val srcEnd: Double, val speed: Double = 1.0, val volume: Double = 1.0,
    // Aspecto del clip (mismas reglas que el editor de escritorio; ver clipLook)
    val fadeIn: Double = 0.0, val fadeOut: Double = 0.0, // s: fundido desde/hacia negro (imagen y sonido)
    val bright: Double = 0.0, val contrast: Double = 1.0, val sat: Double = 1.0, val warmth: Double = 0.0, val filter: String? = null,
    val scale: Double = 1.0, val rot: Double = 0.0, val flip: Boolean = false, val px: Double = 0.0, val py: Double = 0.0, // zoom, giro (° horario), espejo, desplazamiento (fracción del cuadro)
    val kScale: Double? = null, val kPx: Double? = null, val kPy: Double? = null // animación: valores al FINAL del clip (los de arriba son los del inicio)
)

/** Una pista de audio colocada en la línea de tiempo (efectos, voz, música extra). Suena una vez desde [start]. */
@Serializable
data class EAudio(val id: String, val uri: String, val name: String, val kind: String = "sfx", val start: Double, val duration: Double, val volume: Double = 1.0, val fadeIn: Double = 0.0, val fadeOut: Double = 0.0)

/** Un texto con su tiempo. Posición, tamaño y estilo viven en [style] (x, y = centro del bloque, 0..1). */
@Serializable
data class EText(val id: String, val text: String, val start: Double, val duration: Double, val style: TextStyle = TextStyle(), val anim: String = "none", val animDur: Double = 0.4) // anim: none | fade | up | down | left | right

@Serializable
data class EMusic(val uri: String, val name: String, val volume: Double = 0.8)

@Serializable
data class EditorProject(
    val id: Long = 0,
    val name: String = "Proyecto del editor",
    val clips: List<EClip> = emptyList(),
    val texts: List<EText> = emptyList(),
    val music: EMusic? = null,
    val audios: List<EAudio> = emptyList(),
    val fps: Int = 30,
    val quality: String = "media" // alta | media | rapida
)

private var counter = 0
fun eid(prefix: String = "e"): String = prefix + System.currentTimeMillis().toString(36) + (counter++).toString(36) + (Math.random() * 1296).toInt().toString(36)

private fun r3(x: Double): Double = Math.floor(x * 1000 + 0.5) / 1000
private fun clamp(x: Double, lo: Double, hi: Double): Double = min(hi, max(lo, x))

fun clipDur(c: EClip): Double = (c.srcEnd - c.srcStart) / c.speed
fun totalDuration(p: EditorProject): Double = r3(p.clips.sumOf { clipDur(it) })

fun clipStarts(p: EditorProject): List<Double> {
    val out = ArrayList<Double>(p.clips.size)
    var t = 0.0
    for (c in p.clips) { out.add(t); t += clipDur(c) }
    return out
}

data class Located(val index: Int, val start: Double, val src: Double)

/** Clip que se ve en el instante t y el instante equivalente dentro del video original. */
fun locate(p: EditorProject, t: Double): Located? {
    if (p.clips.isEmpty()) return null
    val starts = clipStarts(p)
    val tt = clamp(t, 0.0, max(0.0, totalDuration(p) - 0.001))
    var i = starts.size - 1
    for (k in starts.indices) if (tt < starts[k] + clipDur(p.clips[k])) { i = k; break }
    val c = p.clips[i]
    return Located(i, starts[i], clamp(c.srcStart + (tt - starts[i]) * c.speed, c.srcStart, c.srcEnd))
}

const val MIN_AUDIO = 0.2
val FILTERS: Map<String, List<Double>> = mapOf( // brillo, contraste, saturación, calidez
    "none" to listOf(0.0, 1.0, 1.0, 0.0), "vivid" to listOf(0.02, 1.15, 1.4, 0.05), "warm" to listOf(0.02, 1.05, 1.1, 0.5),
    "cool" to listOf(0.0, 1.05, 1.0, -0.5), "bw" to listOf(0.0, 1.1, 0.0, 0.0), "vintage" to listOf(0.03, 0.9, 0.7, 0.35), "dramatic" to listOf(-0.03, 1.35, 0.9, -0.1)
)

data class ClipLook(
    val fadeIn: Double, val fadeOut: Double, val bright: Double, val contrast: Double, val sat: Double, val warmth: Double,
    val scale: Double, val rot: Double, val flip: Boolean, val px: Double, val py: Double,
    val kScale: Double = scale, val kPx: Double = px, val kPy: Double = py
) {
    val animated: Boolean get() = kScale != scale || kPx != px || kPy != py
}

/** Zoom y posición del clip en la fracción [u] (0 = inicio, 1 = final) de su duración. */
fun frameAt(l: ClipLook, u: Double): Triple<Double, Double, Double> {
    val k = clamp(u, 0.0, 1.0)
    return Triple(l.scale + (l.kScale - l.scale) * k, l.px + (l.kPx - l.px) * k, l.py + (l.kPy - l.py) * k)
}

/** Aspecto completo del clip. Los fundidos nunca pasan de la mitad del clip. */
fun clipLook(c: EClip): ClipLook {
    val half = clipDur(c) / 2
    return ClipLook(clamp(c.fadeIn, 0.0, half), clamp(c.fadeOut, 0.0, half), c.bright, c.contrast, c.sat, c.warmth, c.scale, c.rot, c.flip, c.px, c.py, c.kScale ?: c.scale, c.kPx ?: c.px, c.kPy ?: c.py)
}
fun hasColor(c: EClip) = c.bright != 0.0 || c.contrast != 1.0 || c.sat != 1.0 || c.warmth != 0.0
fun hasFrame(c: EClip) = c.scale != 1.0 || c.rot != 0.0 || c.flip || c.px != 0.0 || c.py != 0.0 || clipLook(c).animated

/** Mantiene textos y audios dentro de la duración del video (tras cortar, borrar o cambiar velocidades). */
fun normalize(p0: EditorProject): EditorProject {
    val total = totalDuration(p0)
    val audios = p0.audios.map { a ->
        val start = clamp(a.start, 0.0, max(0.0, total - MIN_AUDIO))
        val duration = clamp(a.duration, min(MIN_AUDIO, total - start), max(0.0, total - start))
        if (start == a.start && duration == a.duration) a else a.copy(start = r3(start), duration = r3(duration))
    }.filter { total > 0 && it.duration > 0 }
    val p = p0.copy(audios = audios)
    if (total <= 0) return p.copy(texts = emptyList())
    val texts = p.texts.map { t ->
        val start = clamp(t.start, 0.0, max(0.0, total - MIN_TEXT))
        val duration = clamp(t.duration, min(MIN_TEXT, total - start), total - start)
        if (start == t.start && duration == t.duration) t else t.copy(start = r3(start), duration = r3(duration))
    }
    return p.copy(texts = texts)
}

private fun withClips(p: EditorProject, clips: List<EClip>) = normalize(p.copy(clips = clips))

fun addClip(p: EditorProject, videoId: Long, assetDuration: Double, index: Int = p.clips.size): EditorProject {
    val c = EClip(eid("c"), videoId, 0.0, r3(assetDuration))
    val clips = p.clips.toMutableList()
    clips.add(index.coerceIn(0, clips.size), c)
    return withClips(p, clips)
}

data class Edit(val project: EditorProject, val selectId: String)

/** Divide el clip que está bajo el instante t. Devuelve null si t cae demasiado cerca de un borde. */
fun splitAt(p: EditorProject, t: Double): Edit? {
    val loc = locate(p, t) ?: return null
    val c = p.clips[loc.index]
    val local = t - loc.start
    if (local < MIN_CLIP || clipDur(c) - local < MIN_CLIP) return null
    val cut = r3(c.srcStart + local * c.speed)
    val a = c.copy(srcEnd = cut)
    val b = c.copy(id = eid("c"), srcStart = cut)
    val clips = p.clips.toMutableList()
    clips.removeAt(loc.index); clips.add(loc.index, b); clips.add(loc.index, a)
    return Edit(withClips(p, clips), b.id)
}

/** Recorta un borde del clip. [src] es el nuevo instante dentro del video original. */
fun trimClip(p: EditorProject, id: String, startSide: Boolean, src: Double, assetDuration: Double): EditorProject =
    withClips(p, p.clips.map { c ->
        if (c.id != id) c else {
            val minSrc = MIN_CLIP * c.speed
            if (startSide) c.copy(srcStart = r3(clamp(src, 0.0, c.srcEnd - minSrc)))
            else c.copy(srcEnd = r3(clamp(src, c.srcStart + minSrc, assetDuration)))
        }
    })

fun moveClip(p: EditorProject, from: Int, to: Int): EditorProject {
    if (from == to || from < 0 || from >= p.clips.size) return p
    val clips = p.clips.toMutableList()
    val c = clips.removeAt(from)
    clips.add(to.coerceIn(0, clips.size), c)
    return withClips(p, clips)
}

fun removeClip(p: EditorProject, id: String) = withClips(p, p.clips.filter { it.id != id })

fun duplicateClip(p: EditorProject, id: String): Edit? {
    val i = p.clips.indexOfFirst { it.id == id }
    if (i < 0) return null
    val copy = p.clips[i].copy(id = eid("c"))
    val clips = p.clips.toMutableList()
    clips.add(i + 1, copy)
    return Edit(withClips(p, clips), copy.id)
}

fun setClip(
    p: EditorProject, id: String, speed: Double? = null, volume: Double? = null,
    fadeIn: Double? = null, fadeOut: Double? = null, bright: Double? = null, contrast: Double? = null, sat: Double? = null, warmth: Double? = null,
    filter: String? = null, scale: Double? = null, rot: Double? = null, flip: Boolean? = null, px: Double? = null, py: Double? = null,
    kScale: Double? = null, kPx: Double? = null, kPy: Double? = null
): EditorProject =
    withClips(p, p.clips.map { c ->
        if (c.id != id) c else c.copy(
            speed = speed?.let { clamp(it, 0.25, 4.0) } ?: c.speed,
            volume = volume?.let { clamp(it, 0.0, 1.0) } ?: c.volume,
            fadeIn = fadeIn?.let { r3(clamp(it, 0.0, 3.0)) } ?: c.fadeIn,
            fadeOut = fadeOut?.let { r3(clamp(it, 0.0, 3.0)) } ?: c.fadeOut,
            bright = bright?.let { r3(clamp(it, -0.5, 0.5)) } ?: c.bright,
            contrast = contrast?.let { r3(clamp(it, 0.5, 1.5)) } ?: c.contrast,
            sat = sat?.let { r3(clamp(it, 0.0, 2.0)) } ?: c.sat,
            warmth = warmth?.let { r3(clamp(it, -1.0, 1.0)) } ?: c.warmth,
            filter = filter ?: c.filter,
            scale = scale?.let { r3(clamp(it, 0.25, 4.0)) } ?: c.scale,
            rot = rot?.let { r3(clamp(it, -180.0, 180.0)) } ?: c.rot,
            flip = flip ?: c.flip,
            px = px?.let { r3(clamp(it, -1.0, 1.0)) } ?: c.px,
            py = py?.let { r3(clamp(it, -1.0, 1.0)) } ?: c.py,
            kScale = kScale?.let { r3(clamp(it, 0.25, 4.0)) } ?: c.kScale,
            kPx = kPx?.let { r3(clamp(it, -1.0, 1.0)) } ?: c.kPx,
            kPy = kPy?.let { r3(clamp(it, -1.0, 1.0)) } ?: c.kPy
        )
    })

/** Movimientos prediseñados (zoom/paneo de inicio a fin del clip): none, zoomIn, zoomOut, panLeft, panRight. */
fun applyMotion(p: EditorProject, id: String, name: String): EditorProject =
    withClips(p, p.clips.map { c ->
        if (c.id != id) c else {
            val b = c.copy(kScale = null, kPx = null, kPy = null)
            when (name) {
                "zoomIn" -> b.copy(scale = 1.0, px = 0.0, py = 0.0, kScale = 1.3, kPx = 0.0, kPy = 0.0)
                "zoomOut" -> b.copy(scale = 1.3, px = 0.0, py = 0.0, kScale = 1.0, kPx = 0.0, kPy = 0.0)
                "panLeft" -> b.copy(scale = 1.25, px = 0.1, py = 0.0, kScale = 1.25, kPx = -0.1, kPy = 0.0)
                "panRight" -> b.copy(scale = 1.25, px = -0.1, py = 0.0, kScale = 1.25, kPx = 0.1, kPy = 0.0)
                else -> b
            }
        }
    })

/** Aplica un filtro prediseñado (ajusta brillo, contraste, saturación y calidez). */
fun applyFilter(p: EditorProject, id: String, name: String): EditorProject {
    val f = FILTERS[name] ?: return p
    return setClip(p, id, bright = f[0], contrast = f[1], sat = f[2], warmth = f[3], filter = name)
}

/** Transición entre el clip [index] y el siguiente: fundido a negro de [dur] s a cada lado (0 la quita). */
fun setTransition(p: EditorProject, index: Int, dur: Double): EditorProject {
    if (index < 0 || index >= p.clips.size - 1) return p
    val d = r3(clamp(dur, 0.0, 3.0))
    return withClips(p, p.clips.mapIndexed { i, c -> if (i == index) c.copy(fadeOut = d) else if (i == index + 1) c.copy(fadeIn = d) else c })
}
fun transitionAt(p: EditorProject, index: Int): Double {
    val a = p.clips.getOrNull(index) ?: return 0.0
    val b = p.clips.getOrNull(index + 1) ?: return 0.0
    return min(clipLook(a).fadeOut, clipLook(b).fadeIn)
}

// ---------- animación de textos y stickers ----------
const val ANIM_DIST = 120.0 // px (en el cuadro de 1080×1920) que recorre una animación de deslizamiento
data class TextAnimState(val alpha: Double, val dx: Double, val dy: Double)

/** Duración efectiva de la animación de un texto (nunca más de la mitad de lo que dura). */
fun animLen(t: EText): Double = if (t.anim != "none") clamp(t.animDur, 0.1, t.duration / 2) else 0.0

/** Transparencia (0..1) y desplazamiento (px del cuadro 1080×1920) de un texto en el instante [time]. Entra con la animación y sale con ella. */
fun textAnim(t: EText, time: Double): TextAnimState {
    val d = animLen(t)
    if (d <= 0) return TextAnimState(1.0, 0.0, 0.0)
    val lt = time - t.start
    val pin = clamp(lt / d, 0.0, 1.0); val pout = clamp((t.duration - lt) / d, 0.0, 1.0)
    val (vx, vy) = when (t.anim) { "up" -> 0.0 to 1.0; "down" -> 0.0 to -1.0; "left" -> 1.0 to 0.0; "right" -> -1.0 to 0.0; else -> 0.0 to 0.0 }
    val off = ((1 - pin) - (1 - pout)) * ANIM_DIST
    return TextAnimState(min(pin, pout), vx * off, vy * off)
}

/** Agrega un sticker (emoji grande) en [at], con una animación de entrada. */
fun addSticker(p: EditorProject, at: Double, emoji: String, base: TextStyle = TextStyle()): Edit {
    val r = addText(p, at, emoji, base.copy(fontSize = 200f, outline = false, shadow = false, x = 0.5f, y = 0.4f, uppercase = false))
    val t = r.project.texts.first { it.id == r.selectId }
    return Edit(setText(r.project, r.selectId, duration = min(3.0, t.duration), anim = "up", animDur = 0.4), r.selectId)
}

// ---------- pistas de audio ----------
/** Agrega una pista en [at]. [fileDur] es la duración del archivo (0 si se desconoce: ocupa hasta el final). */
fun addAudio(p: EditorProject, uri: String, name: String, kind: String, at: Double, fileDur: Double = 0.0): Edit {
    val total = totalDuration(p)
    val start = clamp(at, 0.0, max(0.0, total - MIN_AUDIO))
    val room = max(MIN_AUDIO, total - start)
    val a = EAudio(eid("a"), uri, name, kind, r3(start), r3(if (fileDur > 0) min(fileDur, room) else room), if (kind == "music") 0.8 else 1.0)
    return Edit(normalize(p.copy(audios = p.audios + a)), a.id)
}
fun setAudio(p: EditorProject, id: String, volume: Double? = null, fadeIn: Double? = null, fadeOut: Double? = null, start: Double? = null, duration: Double? = null): EditorProject =
    normalize(p.copy(audios = p.audios.map { a ->
        if (a.id != id) a else {
            val d = duration ?: a.duration
            a.copy(volume = clamp(volume ?: a.volume, 0.0, 1.0), start = start ?: a.start, duration = d,
                fadeIn = clamp(fadeIn ?: a.fadeIn, 0.0, d / 2), fadeOut = clamp(fadeOut ?: a.fadeOut, 0.0, d / 2))
        }
    })
    )
fun removeAudio(p: EditorProject, id: String) = p.copy(audios = p.audios.filter { it.id != id })
fun moveAudio(p: EditorProject, id: String, start: Double): EditorProject {
    val a = p.audios.find { it.id == id } ?: return p
    return setAudio(p, id, start = r3(clamp(start, 0.0, max(0.0, totalDuration(p) - a.duration))))
}

// ---------- textos ----------
fun addText(p: EditorProject, at: Double, text: String = "Tu texto", style: TextStyle = TextStyle()): Edit {
    val total = totalDuration(p)
    val start = clamp(at, 0.0, max(0.0, total - MIN_TEXT))
    val duration = if (total > 0) clamp(3.0, min(MIN_TEXT, total - start), total - start) else 3.0
    val t = EText(eid("t"), text, r3(start), r3(duration), style)
    return Edit(p.copy(texts = p.texts + t), t.id)
}

fun setText(p: EditorProject, id: String, text: String? = null, start: Double? = null, duration: Double? = null, style: ((TextStyle) -> TextStyle)? = null, anim: String? = null, animDur: Double? = null): EditorProject =
    normalize(p.copy(texts = p.texts.map { t ->
        if (t.id != id) t else t.copy(text = text ?: t.text, start = start ?: t.start, duration = duration ?: t.duration, style = style?.invoke(t.style) ?: t.style, anim = anim ?: t.anim, animDur = animDur ?: t.animDur)
    }))

fun removeText(p: EditorProject, id: String) = p.copy(texts = p.texts.filter { it.id != id })

fun duplicateText(p: EditorProject, id: String): Edit? {
    val t = p.texts.find { it.id == id } ?: return null
    val copy = t.copy(id = eid("t"), style = t.style.copy(y = min(0.92f, t.style.y + 0.08f)))
    return Edit(normalize(p.copy(texts = p.texts + copy)), copy.id)
}

/** Mueve un texto en el tiempo manteniendo su duración. */
fun moveText(p: EditorProject, id: String, start: Double): EditorProject {
    val total = totalDuration(p)
    val d = p.texts.find { it.id == id }?.duration ?: 0.0
    return setText(p, id, start = r3(clamp(start, 0.0, max(0.0, total - d))))
}

/** Cambia el borde izquierdo (startSide) o derecho de un texto a un instante de la línea de tiempo. */
fun resizeText(p: EditorProject, id: String, startSide: Boolean, time: Double): EditorProject {
    val t = p.texts.find { it.id == id } ?: return p
    val total = totalDuration(p)
    val end = t.start + t.duration
    return if (startSide) { val s = clamp(time, 0.0, end - MIN_TEXT); setText(p, id, start = r3(s), duration = r3(end - s)) }
    else setText(p, id, duration = r3(clamp(time, t.start + MIN_TEXT, total) - t.start))
}

/** Textos visibles en el instante t, en orden de capa (los últimos quedan encima). */
fun textsAt(p: EditorProject, t: Double): List<EText> = p.texts.filter { t >= it.start - 1e-6 && t < it.start + it.duration }

/** Ajusta t al punto más cercano (si está a menos de [threshold] segundos). */
fun snap(t: Double, points: List<Double>, threshold: Double): Double {
    var best = t
    var bd = threshold
    for (q in points) { val d = Math.abs(q - t); if (d < bd) { best = q; bd = d } }
    return best
}

fun snapPoints(p: EditorProject, playhead: Double, exceptTextId: String? = null): List<Double> {
    val pts = mutableListOf(0.0, playhead, totalDuration(p))
    pts.addAll(clipStarts(p))
    for (t in p.texts) if (t.id != exceptTextId) { pts.add(t.start); pts.add(t.start + t.duration) }
    return pts
}

/** Convierte una selección automática (plan) en un proyecto editable. */
fun fromPlan(segments: List<Segment>, text: String, style: TextStyle, originalAudio: Boolean, fps: Int, quality: String, name: String = "Desde un video creado"): EditorProject {
    val clips = segments.map { EClip(eid("c"), it.videoId, it.start, r3(it.start + it.duration), 1.0, if (originalAudio) 1.0 else 0.0) }
    var p = EditorProject(name = name, clips = clips, fps = fps, quality = quality)
    if (text.isNotBlank()) p = p.copy(texts = listOf(EText(eid("t"), text, 0.0, totalDuration(p), style)))
    return normalize(p)
}

// ---------- subtítulos desde un guion ----------
/** Divide un guion en frases cortas: máximo [maxWords] palabras y corte natural tras puntuación. */
fun splitCaptions(text: String, maxWords: Int = 4): List<String> {
    val words = text.replace(Regex("\\s+"), " ").trim().split(" ").filter { it.isNotEmpty() }
    val out = ArrayList<String>(); var cur = ArrayList<String>()
    val mw = max(1, maxWords)
    for (w in words) {
        cur.add(w)
        val stop = Regex("[.!?…;:]$").containsMatchIn(w) || (w.endsWith(",") && cur.size >= 2)
        if (cur.size >= mw || (stop && cur.size >= 2) || Regex("[.!?…]$").containsMatchIn(w)) { out.add(cur.joinToString(" ")); cur = ArrayList() }
    }
    if (cur.isNotEmpty()) {
        if (out.isNotEmpty() && cur.size == 1 && out.last().split(" ").size < mw * 2) out[out.size - 1] = out.last() + " " + cur[0] else out.add(cur.joinToString(" "))
    }
    return out
}

/**
 * Reparte las frases del guion por la línea de tiempo entre [from] y [to] (por defecto, todo el video), cada una con una
 * duración proporcional a su longitud. Los subtítulos son textos normales: se pueden mover, editar y borrar.
 */
fun captionsFromText(p: EditorProject, text: String, style: TextStyle, from0: Double = 0.0, to0: Double? = null, maxWords: Int = 4): Edit? {
    val total = totalDuration(p)
    val parts = if (total > 0) splitCaptions(text, maxWords) else emptyList()
    if (parts.isEmpty()) return null
    val from = clamp(from0, 0.0, max(0.0, total - MIN_TEXT))
    val to = clamp(to0 ?: total, from + MIN_TEXT, max(total, from + MIN_TEXT))
    val span = min(to, total) - from
    val weights = parts.map { it.length + 4 }
    val sum = weights.sum().toDouble()
    var t = from
    val texts = parts.mapIndexed { i, s ->
        val d = if (i == parts.size - 1) from + span - t else span * weights[i] / sum
        EText(eid("t"), s, r3(t), r3(max(MIN_TEXT, d)), style).also { t += d }
    }
    return Edit(normalize(p.copy(texts = p.texts + texts)), texts.first().id)
}
