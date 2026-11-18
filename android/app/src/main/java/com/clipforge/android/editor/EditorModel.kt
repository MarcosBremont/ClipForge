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
data class EClip(val id: String, val videoId: Long, val srcStart: Double, val srcEnd: Double, val speed: Double = 1.0, val volume: Double = 1.0)

/** Un texto con su tiempo. Posición, tamaño y estilo viven en [style] (x, y = centro del bloque, 0..1). */
@Serializable
data class EText(val id: String, val text: String, val start: Double, val duration: Double, val style: TextStyle = TextStyle())

@Serializable
data class EMusic(val uri: String, val name: String, val volume: Double = 0.8)

@Serializable
data class EditorProject(
    val id: Long = 0,
    val name: String = "Proyecto del editor",
    val clips: List<EClip> = emptyList(),
    val texts: List<EText> = emptyList(),
    val music: EMusic? = null,
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

/** Mantiene los textos dentro de la duración del video (tras cortar, borrar o cambiar velocidades). */
fun normalize(p: EditorProject): EditorProject {
    val total = totalDuration(p)
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

fun setClip(p: EditorProject, id: String, speed: Double? = null, volume: Double? = null): EditorProject =
    withClips(p, p.clips.map { c ->
        if (c.id != id) c else c.copy(
            speed = speed?.let { clamp(it, 0.25, 4.0) } ?: c.speed,
            volume = volume?.let { clamp(it, 0.0, 1.0) } ?: c.volume
        )
    })

// ---------- textos ----------
fun addText(p: EditorProject, at: Double, text: String = "Tu texto", style: TextStyle = TextStyle()): Edit {
    val total = totalDuration(p)
    val start = clamp(at, 0.0, max(0.0, total - MIN_TEXT))
    val duration = if (total > 0) clamp(3.0, min(MIN_TEXT, total - start), total - start) else 3.0
    val t = EText(eid("t"), text, r3(start), r3(duration), style)
    return Edit(p.copy(texts = p.texts + t), t.id)
}

fun setText(p: EditorProject, id: String, text: String? = null, start: Double? = null, duration: Double? = null, style: ((TextStyle) -> TextStyle)? = null): EditorProject =
    normalize(p.copy(texts = p.texts.map { t ->
        if (t.id != id) t else t.copy(text = text ?: t.text, start = start ?: t.start, duration = duration ?: t.duration, style = style?.invoke(t.style) ?: t.style)
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
