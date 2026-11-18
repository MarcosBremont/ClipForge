package com.clipforge.android.export

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.graphics.Matrix
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.effect.Brightness
import androidx.media3.effect.Contrast
import androidx.media3.effect.HslAdjustment
import androidx.media3.effect.MatrixTransformation
import androidx.media3.effect.RgbAdjustment
import androidx.media3.effect.RgbMatrix
import androidx.media3.effect.OverlaySettings
import com.clipforge.android.editor.ClipLook
import com.clipforge.android.editor.EText
import com.clipforge.android.editor.frameAt
import com.clipforge.android.editor.textAnim
import java.nio.ByteBuffer
import java.nio.ByteOrder
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
val NO_LOOK = ClipLook(0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, false, 0.0, 0.0)
data class EditorClipSpec(val uri: String, val srcStartMs: Long, val srcEndMs: Long, val speed: Float, val volume: Float, val look: ClipLook = NO_LOOK)
data class EditorAudioSpec(val uri: String, val startMs: Long, val durMs: Long, val volume: Float, val fadeInMs: Long, val fadeOutMs: Long)
data class EditorTextSpec(val text: String, val style: TextStyle, val startUs: Long, val endUs: Long, val anim: String = "none", val animDur: Double = 0.4)
data class EditorSpec(
    val name: String,
    val clips: List<EditorClipSpec>,
    val texts: List<EditorTextSpec>,
    val musicUri: String?,
    val musicVolume: Float,
    val fps: Int,
    val quality: String,
    val audios: List<EditorAudioSpec> = emptyList()
)

/** Multiplica el volumen por un fundido de entrada y/o salida (instantes locales del elemento, ya a velocidad final). */
private class FadeAudioProcessor(private val fadeInUs: Long, private val fadeOutUs: Long, private val durUs: Long) : BaseAudioProcessor() {
    private var frames = 0L
    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat =
        if (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT) inputAudioFormat else AudioProcessor.AudioFormat.NOT_SET
    override fun queueInput(inputBuffer: ByteBuffer) {
        val n = inputBuffer.remaining()
        val out = replaceOutputBuffer(n).order(ByteOrder.nativeOrder())
        val ch = inputAudioFormat.channelCount
        val sr = inputAudioFormat.sampleRate.toLong()
        val src = inputBuffer.order(ByteOrder.nativeOrder())
        var left = n
        while (left >= 2 * ch) {
            val t = frames * 1_000_000L / sr
            var g = 1f
            if (fadeInUs > 0) g = minOf(g, t.toFloat() / fadeInUs)
            if (fadeOutUs > 0) g = minOf(g, (durUs - t).toFloat() / fadeOutUs)
            g = g.coerceIn(0f, 1f)
            repeat(ch) { out.putShort((src.short * g).toInt().coerceIn(-32768, 32767).toShort()) }
            frames++; left -= 2 * ch
        }
        while (src.hasRemaining()) out.put(src.get()) // restos que no forman un fotograma completo
        out.flip()
    }
    override fun onFlush() { frames = 0 }
}

/** Fundido a negro de imagen: multiplica RGB. Los instantes son de la línea de tiempo (los efectos de Transformer usan tiempo global). */
private class FadeRgb(private val startUs: Long, private val durUs: Long, private val fadeInUs: Long, private val fadeOutUs: Long) : RgbMatrix {
    override fun getMatrix(presentationTimeUs: Long, useHdr: Boolean): FloatArray {
        val t = presentationTimeUs - startUs
        var g = 1f
        if (fadeInUs > 0) g = minOf(g, t.toFloat() / fadeInUs)
        if (fadeOutUs > 0) g = minOf(g, (durUs - t).toFloat() / fadeOutUs)
        g = g.coerceIn(0f, 1f)
        return floatArrayOf(g, 0f, 0f, 0f, 0f, g, 0f, 0f, 0f, 0f, g, 0f, 0f, 0f, 0f, 1f)
    }
}

/** Encuadre: espejo → zoom → giro (° horario) → desplazamiento, sobre el fotograma 1080×1920 (lo que queda fuera se recorta; el resto, negro). */
fun frameMatrix(l: ClipLook, w: Int = Exporter.WIDTH, h: Int = Exporter.HEIGHT, scale: Double = l.scale, px: Double = l.px, py: Double = l.py): Matrix {
    val m = Matrix()
    if (l.flip) m.postScale(-1f, 1f)
    m.postScale(scale.toFloat(), scale.toFloat())
    if (l.rot != 0.0) { m.postScale(w / 2f, h / 2f); m.postRotate(-l.rot.toFloat()); m.postScale(2f / w, 2f / h) } // corrige la proporción para girar sin deformar
    m.postTranslate((px * 2).toFloat(), (-py * 2).toFloat())
    return m
}

/** Muestra un bitmap solo entre [startUs, endUs) de la línea de tiempo (instantes globales de la secuencia). */
private class TimedOverlay(private val shown: Bitmap, private val blank: Bitmap, private val startUs: Long, private val endUs: Long, private val anim: EText? = null) : BitmapOverlay() {
    override fun getBitmap(presentationTimeUs: Long): Bitmap = if (presentationTimeUs in startUs until endUs) shown else blank
    /** Entrada y salida animadas: transparencia y desplazamiento (en NDC: 1080/2 px = 1.0 horizontal, 1920/2 px = 1.0 vertical). */
    override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings {
        val a = anim ?: return super.getOverlaySettings(presentationTimeUs)
        val st = textAnim(a, presentationTimeUs / 1_000_000.0)
        return OverlaySettings.Builder().setAlphaScale(st.alpha.toFloat()).setBackgroundFrameAnchor((st.dx / 540.0).toFloat(), (-st.dy / 960.0).toFloat()).build()
    }
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
        var startUs = 0L
        val items = spec.clips.map { c ->
            // Instancias nuevas por clip: cada OverlayEffect gestiona su propia textura.
            val overlays: List<TextureOverlay> = textBitmaps.map { (t, bmp) -> TimedOverlay(bmp, blank, t.startUs, t.endUs, if (t.anim != "none") EText("", "", t.startUs / 1e6, (t.endUs - t.startUs) / 1e6, TextStyle(), t.anim, t.animDur) else null) }
            val durUs = ((c.srcEndMs - c.srcStartMs) * 1000 / c.speed).toLong()
            item(c.uri, c.srcStartMs, c.srcEndMs, c.speed, c.volume, spec.fps, overlays, c.look, startUs, durUs).also { startUs += durUs }
        }
        val sequences = mutableListOf(EditedMediaItemSequence(items))
        val totalMs = spec.clips.sumOf { ((it.srcEndMs - it.srcStartMs) / it.speed).toLong() }
        spec.musicUri?.let { sequences.add(musicSequence(it, spec.musicVolume, totalMs)) }
        val tmp = ArrayList<File>()
        for (a in spec.audios) if (a.durMs > 0) sequences.add(audioSequence(a, tmp))
        launch(cont, sequences, out, spec.quality, bitmaps, onProgress, tmp)
    }

    // ---------------------------------------------------------------- piezas comunes

    private fun item(uri: String, startMs: Long, endMs: Long, speed: Float, volume: Float, fps: Int, overlays: List<TextureOverlay>, look: ClipLook = NO_LOOK, startUs: Long = 0, durUs: Long = 0): EditedMediaItem {
        val mi = MediaItem.Builder().setUri(uri)
            .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs).setEndPositionMs(endMs).build()).build()
        val video = mutableListOf<Effect>()
        if (speed != 1f) video.add(SpeedChangeEffect(speed))
        // 30 fps: descarta fotogramas. 60 fps: conserva el ritmo nativo del original (Transformer no interpola).
        if (fps == 30) video.add(FrameDropEffect.createDefaultFrameDropEffect(30f))
        video.add(Presentation.createForWidthAndHeight(WIDTH, HEIGHT, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP))
        // Color (antes del encuadre, para no teñir el fondo negro), encuadre y fundido.
        if (look.bright != 0.0) video.add(Brightness(look.bright.toFloat()))
        if (look.contrast != 1.0) video.add(Contrast((look.contrast - 1).toFloat()))
        if (look.sat != 1.0) video.add(HslAdjustment.Builder().adjustSaturation(((look.sat - 1) * 100).toFloat()).build())
        if (look.warmth != 0.0) video.add(RgbAdjustment.Builder().setRedScale((1 + 0.15 * look.warmth).toFloat()).setBlueScale((1 - 0.15 * look.warmth).toFloat()).build())
        if (look.animated) {
            // Zoom y posición cambian linealmente a lo largo del clip (los instantes de los efectos son los de la línea de tiempo).
            video.add(MatrixTransformation { us ->
                val (sc, x, y) = frameAt(look, if (durUs > 0) (us - startUs).toDouble() / durUs else 0.0)
                frameMatrix(look, scale = sc, px = x, py = y)
            })
        } else if (look.scale != 1.0 || look.rot != 0.0 || look.flip || look.px != 0.0 || look.py != 0.0) {
            val m = frameMatrix(look)
            video.add(MatrixTransformation { Matrix(m) })
        }
        val fi = (look.fadeIn * 1_000_000).toLong(); val fo = (look.fadeOut * 1_000_000).toLong()
        if (fi > 0 || fo > 0) video.add(FadeRgb(startUs, durUs, fi, fo))
        // El texto va DESPUÉS del escalado, cuando el fotograma ya mide 1080×1920 como el bitmap (mismo dibujado que la vista previa).
        if (overlays.isNotEmpty()) video.add(OverlayEffect(ImmutableList.copyOf(overlays)))
        val audio = mutableListOf<AudioProcessor>()
        if (speed != 1f) audio.add(SonicAudioProcessor().apply { setSpeed(speed); setPitch(1f) }) // cambia la velocidad sin cambiar el tono
        if (volume in 0.001f..0.999f) audio.add(volumeProcessor(volume))
        if ((fi > 0 || fo > 0) && volume > 0.001f) audio.add(FadeAudioProcessor(fi, fo, durUs))
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

    /** Pista de audio con inicio propio: un silencio (WAV generado) hasta el inicio y luego el archivo recortado a su duración. */
    private fun audioSequence(a: EditorAudioSpec, tmp: MutableList<File>): EditedMediaItemSequence {
        val items = ArrayList<EditedMediaItem>()
        if (a.startMs > 0) items.add(EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(silenceWav(a.startMs).also { tmp.add(it) }))).setRemoveVideo(true).build())
        val proc = mutableListOf<AudioProcessor>()
        if (a.volume < 0.999f) proc.add(volumeProcessor(a.volume))
        if (a.fadeInMs > 0 || a.fadeOutMs > 0) proc.add(FadeAudioProcessor(a.fadeInMs * 1000, a.fadeOutMs * 1000, a.durMs * 1000))
        items.add(
            EditedMediaItem.Builder(
                MediaItem.Builder().setUri(a.uri)
                    .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setStartPositionMs(0).setEndPositionMs(a.durMs).build()).build()
            ).setRemoveVideo(true).setEffects(Effects(proc, emptyList<Effect>())).build()
        )
        return EditedMediaItemSequence(items)
    }

    /** WAV de silencio (8 kHz, mono, 16 bits) de la duración pedida, en la caché. */
    private fun silenceWav(ms: Long): File {
        val rate = 8000
        val samples = (ms * rate / 1000).toInt().coerceAtLeast(1)
        val data = samples * 2
        val f = File.createTempFile("silence", ".wav", ctx.cacheDir)
        f.outputStream().buffered().use { o ->
            val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            h.put("RIFF".toByteArray()); h.putInt(36 + data); h.put("WAVEfmt ".toByteArray()); h.putInt(16)
            h.putShort(1); h.putShort(1); h.putInt(rate); h.putInt(rate * 2); h.putShort(2); h.putShort(16)
            h.put("data".toByteArray()); h.putInt(data)
            o.write(h.array())
            val zeros = ByteArray(8192)
            var left = data
            while (left > 0) { val n = minOf(left, zeros.size); o.write(zeros, 0, n); left -= n }
        }
        return f
    }

    private fun volumeProcessor(vol: Float): ChannelMixingAudioProcessor {
        val p = ChannelMixingAudioProcessor()
        for (ch in 1..2) p.putChannelMixingMatrix(ChannelMixingMatrix.create(ch, ch).scaleBy(vol.coerceIn(0f, 1f)))
        return p
    }

    private fun launch(
        cont: CancellableContinuation<Unit>, sequences: List<EditedMediaItemSequence>, out: File, quality: String,
        bitmaps: List<Bitmap>, onProgress: (Float) -> Unit, tmpFiles: List<File> = emptyList()
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
                    handler.removeCallbacks(progress); bitmaps.forEach { it.recycle() }; tmpFiles.forEach { it.delete() }
                    if (cont.isActive) cont.resume(Unit)
                }
                override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                    handler.removeCallbacks(progress); bitmaps.forEach { it.recycle() }; tmpFiles.forEach { it.delete() }
                    if (cont.isActive) cont.resumeWithException(exportException)
                }
            })
            .build()
        val holder = ProgressHolder()
        progress = Runnable {
            if (transformer.getProgress(holder) != Transformer.PROGRESS_STATE_NOT_STARTED) onProgress(holder.progress / 100f)
            handler.postDelayed(progress, 250)
        }
        cont.invokeOnCancellation { handler.post { handler.removeCallbacks(progress); transformer.cancel(); tmpFiles.forEach { it.delete() } } }
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

