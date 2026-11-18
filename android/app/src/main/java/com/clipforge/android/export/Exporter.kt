package com.clipforge.android.export

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.SpeedChangeEffect
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.clipforge.android.model.GenSettings
import com.clipforge.android.model.TextStyle
import com.clipforge.android.text.TextRenderer
import com.google.common.collect.ImmutableList
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class ExportClip(val uri: String, val startMs: Long, val durMs: Long)

data class ExportSpec(
    val name: String,
    val clips: List<ExportClip>,
    val text: String,
    val style: TextStyle,
    val settings: GenSettings
)

// ---- editor de video
data class EditorClipSpec(val uri: String, val srcStartMs: Long, val srcEndMs: Long, val speed: Float, val volume: Float)
data class EditorTextSpec(val text: String, val style: TextStyle, val startUs: Long, val endUs: Long)
data class EditorSpec(
    val name: String,
    val clips: List<EditorClipSpec>,
    val texts: List<EditorTextSpec>,
    val musicUri: String?,
    val musicVolume: Float,
    val fps: Int,
    val quality: String
)

/** Muestra un bitmap solo entre [startUs, endUs) de la línea de tiempo (instantes globales de la secuencia). */
private class TimedOverlay(private val shown: Bitmap, private val blank: Bitmap, private val startUs: Long, private val endUs: Long) : BitmapOverlay() {
    override fun getBitmap(presentationTimeUs: Long): Bitmap = if (presentationTimeUs in startUs until endUs) shown else blank
}

/** Exporta con Media3 Transformer: recorte, escalado/recorte 1080×1920, concatenación, texto superpuesto, música. H.264 + AAC. */
class Exporter(private val ctx: Context) {

    /**
     * Generador automático. Debe llamarse desde el hilo principal (Transformer necesita un Looper).
     * Media3 1.4 codifica el video vertical como fotogramas 1920×1080 con la etiqueta de rotación 90°, igual que las
     * cámaras de los teléfonos: se ve y se publica como 1080×1920.
     */
    suspend fun render(spec: ExportSpec, out: File, onProgress: (Float) -> Unit) = suspendCancellableCoroutine { cont ->
        require(spec.clips.isNotEmpty()) { "No hay fragmentos que exportar" }
        val s = spec.settings
        val overlay = TextRenderer.overlayBitmap(spec.text, spec.style, s.watermark)
        val items = spec.clips.map { clip ->
            val overlays = if (overlay != null) listOf<TextureOverlay>(BitmapOverlay.createStaticBitmapOverlay(overlay)) else emptyList()
            item(clip.uri, clip.startMs, clip.startMs + clip.durMs, 1f, if (s.originalAudio) 1f else 0f, s.fps, overlays)
        }
        val sequences = mutableListOf(EditedMediaItemSequence(items))
        s.musicUri?.let { sequences.add(musicSequence(it, s.musicVolume, spec.clips.sumOf { c -> c.durMs })) }
        launch(cont, sequences, out, s.quality, listOfNotNull(overlay), onProgress)
    }

    /** Editor de video: clips con velocidad y volumen propios, varios textos con su tiempo, música. */
    suspend fun renderEditor(spec: EditorSpec, out: File, onProgress: (Float) -> Unit) = suspendCancellableCoroutine { cont ->
        require(spec.clips.isNotEmpty()) { "La línea de tiempo está vacía" }
        val bitmaps = ArrayList<Bitmap>()
        val blank = Bitmap.createBitmap(TextRenderer.W, TextRenderer.H, Bitmap.Config.ARGB_8888).also { bitmaps.add(it) }
        val textBitmaps = spec.texts.filter { it.endUs > it.startUs && it.text.isNotBlank() }.map { t ->
            val bmp = Bitmap.createBitmap(TextRenderer.W, TextRenderer.H, Bitmap.Config.ARGB_8888)
            TextRenderer.draw(Canvas(bmp), t.text, t.style, 1f)
            bitmaps.add(bmp)
            t to bmp
        }
        val items = spec.clips.map { c ->
            // Instancias nuevas por clip: cada OverlayEffect gestiona su propia textura.
            val overlays: List<TextureOverlay> = textBitmaps.map { (t, bmp) -> TimedOverlay(bmp, blank, t.startUs, t.endUs) }
            item(c.uri, c.srcStartMs, c.srcEndMs, c.speed, c.volume, spec.fps, overlays)
        }
        val sequences = mutableListOf(EditedMediaItemSequence(items))
        val totalMs = spec.clips.sumOf { ((it.srcEndMs - it.srcStartMs) / it.speed).toLong() }
        spec.musicUri?.let { sequences.add(musicSequence(it, spec.musicVolume, totalMs)) }
        launch(cont, sequences, out, spec.quality, bitmaps, onProgress)
    }

    // ---------------------------------------------------------------- piezas comunes

    private fun item(uri: String, startMs: Long, endMs: Long, speed: Float, volume: Float, fps: Int, overlays: List<TextureOverlay>): EditedMediaItem {
        val mi = MediaItem.Builder().setUri(uri)
            .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs).setEndPositionMs(endMs).build()).build()
        val video = mutableListOf<Effect>()
        if (speed != 1f) video.add(SpeedChangeEffect(speed))
        // 30 fps: descarta fotogramas. 60 fps: conserva el ritmo nativo del original (Transformer no interpola).
        if (fps == 30) video.add(FrameDropEffect.createDefaultFrameDropEffect(30f))
        video.add(Presentation.createForWidthAndHeight(WIDTH, HEIGHT, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP))
        // El texto va DESPUÉS del escalado, cuando el fotograma ya mide 1080×1920 como el bitmap (mismo dibujado que la vista previa).
        if (overlays.isNotEmpty()) video.add(OverlayEffect(ImmutableList.copyOf(overlays)))
        val audio = mutableListOf<AudioProcessor>()
        if (speed != 1f) audio.add(SonicAudioProcessor().apply { setSpeed(speed); setPitch(1f) }) // cambia la velocidad sin cambiar el tono
        if (volume in 0.001f..0.999f) audio.add(volumeProcessor(volume))
        return EditedMediaItem.Builder(mi)
            .setRemoveAudio(volume <= 0.001f)
            .setEffects(Effects(audio, video))
            .build()
    }

    private fun musicSequence(uri: String, volume: Float, totalMs: Long): EditedMediaItemSequence {
        val music = EditedMediaItem.Builder(
            MediaItem.Builder().setUri(uri)
                .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setStartPositionMs(0).setEndPositionMs(totalMs).build()).build()
        ).setRemoveVideo(true)
            .setEffects(Effects(listOf<AudioProcessor>(volumeProcessor(volume)), emptyList<Effect>()))
            .build()
        return EditedMediaItemSequence(listOf(music), true) // en bucle si la canción es más corta que el video
    }

    private fun volumeProcessor(vol: Float): ChannelMixingAudioProcessor {
        val p = ChannelMixingAudioProcessor()
        for (ch in 1..2) p.putChannelMixingMatrix(ChannelMixingMatrix.create(ch, ch).scaleBy(vol.coerceIn(0f, 1f)))
        return p
    }

    private fun launch(
        cont: CancellableContinuation<Unit>, sequences: List<EditedMediaItemSequence>, out: File, quality: String,
        bitmaps: List<Bitmap>, onProgress: (Float) -> Unit
    ) {
        out.parentFile?.mkdirs()
        if (out.exists()) out.delete()
        val handler = Handler(Looper.getMainLooper())
        val composition = Composition.Builder(sequences)
            .experimentalSetForceAudioTrack(true) // pista AAC siempre (silencio si no hay audio), para que todos los reproductores acepten el MP4
            .build()
        val bitrate = when (quality) { "alta" -> 14_000_000; "rapida" -> 5_000_000; else -> 9_000_000 }
        val encoder = DefaultEncoderFactory.Builder(ctx)
            .setEnableFallback(true)
            .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
            .build()
        lateinit var progress: Runnable
        val transformer = Transformer.Builder(ctx)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoder)
            .addListener(object : Transformer.Listener {
                override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                    handler.removeCallbacks(progress); bitmaps.forEach { it.recycle() }
                    if (cont.isActive) cont.resume(Unit)
                }
                override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                    handler.removeCallbacks(progress); bitmaps.forEach { it.recycle() }
                    if (cont.isActive) cont.resumeWithException(exportException)
                }
            })
            .build()
        val holder = ProgressHolder()
        progress = Runnable {
            if (transformer.getProgress(holder) != Transformer.PROGRESS_STATE_NOT_STARTED) onProgress(holder.progress / 100f)
            handler.postDelayed(progress, 250)
        }
        cont.invokeOnCancellation { handler.post { handler.removeCallbacks(progress); transformer.cancel() } }
        transformer.start(composition, out.absolutePath)
        handler.post(progress)
    }

    /** Publica el MP4 terminado en Movies/ClipForge (visible en la galería). */
    fun saveToMovies(src: File, displayName: String): Uri {
        val cr = ctx.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/ClipForge")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val uri = cr.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: error("No se pudo crear el archivo en Movies/ClipForge")
        try {
            cr.openOutputStream(uri)!!.use { o -> src.inputStream().use { it.copyTo(o) } }
            values.clear(); values.put(MediaStore.Video.Media.IS_PENDING, 0)
            cr.update(uri, values, null, null)
        } catch (e: Exception) { cr.delete(uri, null, null); throw e }
        return uri
    }

    companion object {
        const val WIDTH = 1080
        const val HEIGHT = 1920
    }
}

