package com.clipforge.android.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val AppJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; isLenient = true }

/** Estilo del texto. Lienzo lógico de 1080×1920; los colores son #RRGGBB o #AARRGGBB. */
@Serializable
data class TextStyle(
    val fontFamily: String = "sans-serif",
    val fontSize: Float = 76f,
    val fontWeight: Int = 700,
    val color: String = "#FFFFFF",
    val align: String = "center", // left | center | right
    val x: Float = 0.5f,
    val y: Float = 0.5f,
    val maxWidth: Float = 0.86f,
    val shadow: Boolean = true,
    val shadowBlur: Float = 10f,
    val shadowColor: String = "#BF000000",
    val outline: Boolean = true,
    val outlineWidth: Float = 6f,
    val outlineColor: String = "#000000",
    val lineHeight: Float = 1.18f,
    val uppercase: Boolean = false
)

@Serializable
data class GenSettings(
    val duration: Int = 15, // 10..60
    val auto: Boolean = true,
    val segmentCount: Int? = null,
    val segmentLength: Double? = null,
    val speed: String = "normal", // lento | normal | rapido
    val fps: Int = 30, // 30 | 60
    val quality: String = "media", // alta | media | rapida
    val originalAudio: Boolean = false,
    val musicUri: String? = null,
    val musicName: String? = null,
    val musicVolume: Float = 0.8f,
    val versions: Int = 1,
    val watermark: String = "",
    val useAI: Boolean = false
)

@Serializable
data class Segment(val uid: String, val videoId: Long, val start: Double, val duration: Double)

@Serializable
data class Plan(val segments: List<Segment>, val seed: Long)

/** Borrador de proyecto en edición (se guarda solo en Room). */
@Serializable
data class Draft(
    val projectId: Long = 0,
    val name: String = "Proyecto nuevo",
    val text: String = "",
    val settings: GenSettings = GenSettings(),
    val style: TextStyle = TextStyle(),
    val plan: Plan? = null
)

val FONT_CHOICES = listOf(
    "sans-serif" to "Sans",
    "sans-serif-black" to "Sans negra",
    "sans-serif-condensed" to "Condensada",
    "serif" to "Serif",
    "monospace" to "Monoespaciada",
    "cursive" to "Cursiva"
)
