package com.clipforge.android

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clipforge.android.editor.ClipLook
import com.clipforge.android.export.EditorAudioSpec
import com.clipforge.android.export.EditorClipSpec
import com.clipforge.android.export.EditorSpec
import com.clipforge.android.export.EditorTextSpec
import com.clipforge.android.export.Exporter
import com.clipforge.android.model.TextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.sqrt

/** Exportación del editor en un dispositivo real: velocidad, volumen por clip, textos con tiempo, música. */
@RunWith(AndroidJUnit4::class)
class EditorExportInstrumentedTest {
    private lateinit var ctx: Context
    private lateinit var dir: File

    @Before fun setUp() {
        ctx = InstrumentationRegistry.getInstrumentation().targetContext
        dir = File(ctx.cacheDir, "editor-test").apply { deleteRecursively(); mkdirs() }
    }

    private fun asset(name: String): String {
        val f = File(dir, name)
        InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { i -> f.outputStream().use { i.copyTo(it) } }
        return Uri.fromFile(f).toString()
    }

    private fun frame(video: File, atMs: Long): Bitmap {
        val m = MediaMetadataRetriever(); m.setDataSource(video.absolutePath)
        val b = m.getFrameAtTime(atMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST)!!
        m.release(); return b
    }

    private fun near(argb: Int, r: Int, g: Int, b: Int, tol: Int = 60) =
        Math.abs((argb shr 16 and 255) - r) <= tol && Math.abs((argb shr 8 and 255) - g) <= tol && Math.abs((argb and 255) - b) <= tol

    private fun whitePixels(bmp: Bitmap): Int {
        var n = 0
        for (y in bmp.height * 40 / 100 until bmp.height * 60 / 100 step 2) for (x in 0 until bmp.width step 2) {
            val p = bmp.getPixel(x, y); if ((p shr 16 and 255) > 235 && (p shr 8 and 255) > 235 && (p and 255) > 235) n++
        }
        return n
    }

    /** Nivel RMS (PCM 16 bit) del audio entre dos instantes. */
    private fun audioRms(file: File, fromMs: Long, toMs: Long): Double {
        val ex = MediaExtractor(); ex.setDataSource(file.path)
        val ti = (0 until ex.trackCount).first { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("audio/") }
        ex.selectTrack(ti)
        val fmt = ex.getTrackFormat(ti)
        val codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
        codec.configure(fmt, null, null, 0); codec.start()
        ex.seekTo(fromMs * 1000, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
        val info = MediaCodec.BufferInfo()
        var sum = 0.0; var n = 0L; var eos = false; var done = false
        val deadline = System.currentTimeMillis() + 20_000
        while (!done && System.currentTimeMillis() < deadline) {
            if (!eos) {
                val i = codec.dequeueInputBuffer(10_000)
                if (i >= 0) {
                    val buf = codec.getInputBuffer(i)!!
                    val sz = ex.readSampleData(buf, 0)
                    if (sz < 0 || ex.sampleTime > toMs * 1000) { codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); eos = true }
                    else { codec.queueInputBuffer(i, 0, sz, ex.sampleTime, 0); ex.advance() }
                }
            }
            val o = codec.dequeueOutputBuffer(info, 10_000)
            if (o >= 0) {
                if (info.size > 0 && info.presentationTimeUs in (fromMs * 1000)..(toMs * 1000)) {
                    val sb = codec.getOutputBuffer(o)!!.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                    while (sb.hasRemaining()) { val v = sb.get().toDouble(); sum += v * v; n++ }
                }
                codec.releaseOutputBuffer(o, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) done = true
            }
        }
        codec.stop(); codec.release(); ex.release()
        return sqrt(sum / max(n, 1))
    }

    private fun render(spec: EditorSpec, name: String): File {
        val out = File(dir, name)
        runBlocking { withContext(Dispatchers.Main) { Exporter(ctx).renderEditor(spec, out) { } } }
        return out
    }

    private fun spec(texts: List<EditorTextSpec>, music: String? = null): EditorSpec {
        val red = asset("red.mp4"); val blue = asset("blue.mp4"); val green = asset("green.mp4")
        return EditorSpec(
            "t", listOf(
                EditorClipSpec(red, 0, 4000, 2f, 0f),     // 0–2 s rojo, 2× y mudo
                EditorClipSpec(blue, 0, 2000, 1f, 1f),    // 2–4 s azul con sonido
                EditorClipSpec(green, 0, 1000, 0.5f, 1f)  // 4–6 s verde, cámara lenta, sin pista de audio
            ), texts, music, 0.5f, 30, "rapida"
        )
    }

    @Test fun clipsVelocidadYTextoConTiempo() {
        val style = TextStyle(fontSize = 220f, fontWeight = 900, color = "#FFFFFF", outline = false, shadow = false)
        val out = render(spec(listOf(EditorTextSpec("WWWW", style, 3_000_000, 5_000_000))), "a.mp4")

        // Duración = suma con velocidades (2 + 2 + 2 s) y dimensiones visibles 1080×1920
        val m = MediaMetadataRetriever(); m.setDataSource(out.absolutePath)
        val dur = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong()
        val w = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)!!.toInt()
        val h = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)!!.toInt()
        val rot = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
        m.release()
        assertTrue("duración $dur ms (esperada ~6000)", Math.abs(dur - 6000) < 400)
        val swap = rot == "90" || rot == "270"
        assertTrue("dimensiones ${w}x$h rot=$rot", (if (swap) h else w) == 1080 && (if (swap) w else h) == 1920)

        // Cada clip en su sitio
        assertTrue("rojo a 1 s", near(frame(out, 1000).getPixel(100, 100), 255, 0, 0))
        assertTrue("azul a 2,6 s", near(frame(out, 2600).getPixel(100, 100), 0, 0, 255))
        assertTrue("verde a 5,5 s", near(frame(out, 5500).getPixel(100, 100), 0, 255, 0))

        // El texto solo se ve entre 3 y 5 s
        val before = whitePixels(frame(out, 1000)); val during = whitePixels(frame(out, 4000)); val during2 = whitePixels(frame(out, 4800)); val after = whitePixels(frame(out, 5600))
        assertTrue("sin texto antes ($before)", before < 50)
        assertTrue("texto a 4 s ($during)", during > 2000)
        assertTrue("texto a 4,8 s, ya en otro clip ($during2)", during2 > 2000)
        assertTrue("sin texto después ($after)", after < 50)
    }

    @Test fun volumenPorClipYMusica() {
        val out = render(spec(emptyList()), "b.mp4")
        val rojo = audioRms(out, 200, 1800); val azul = audioRms(out, 2200, 3800); val verde = audioRms(out, 4200, 5800)
        assertTrue("clip rojo mudo (rms=$rojo)", rojo < 50)
        assertTrue("clip azul suena (rms=$azul)", azul > 500)
        assertTrue("clip sin pista de audio en silencio (rms=$verde)", verde < 50)

        val music = asset("music.m4a")
        val withMusic = render(spec(emptyList(), music), "c.mp4")
        assertTrue("la música suena aunque el clip esté mudo (rms=${audioRms(withMusic, 200, 1800)})", audioRms(withMusic, 200, 1800) > 300)
    }

    // ---------------------------------------------------------------- aspecto del clip (Fase 1)
    private fun look(fadeIn: Double = 0.0, fadeOut: Double = 0.0, bright: Double = 0.0, contrast: Double = 1.0, sat: Double = 1.0, warmth: Double = 0.0,
                     scale: Double = 1.0, rot: Double = 0.0, flip: Boolean = false, px: Double = 0.0, py: Double = 0.0,
                     kScale: Double = scale, kPx: Double = px, kPy: Double = py) =
        ClipLook(fadeIn, fadeOut, bright, contrast, sat, warmth, scale, rot, flip, px, py, kScale, kPx, kPy)

    private fun one(asset: String, look: ClipLook, name: String, dur: Long = 4000, audios: List<EditorAudioSpec> = emptyList(), volume: Float = 1f): File =
        render(EditorSpec("t", listOf(EditorClipSpec(asset(asset), 0, dur, 1f, volume, look)), emptyList(), null, 0.5f, 30, "rapida", audios), name)

    private fun lum(p: Int) = ((p shr 16 and 255) + (p shr 8 and 255) + (p and 255)) / 3

    @Test fun fundidoDeEntradaYSalida() {
        val out = one("red.mp4", look(fadeIn = 1.0, fadeOut = 1.0), "fade.mp4")
        val a = frame(out, 60).getPixel(300, 300); val b = frame(out, 2000).getPixel(300, 300); val c = frame(out, 3900).getPixel(300, 300)
        assertTrue("empieza casi negro (${lum(a)})", lum(a) < 90)
        assertTrue("rojo pleno al centro", near(b, 255, 0, 0))
        assertTrue("termina casi negro (${lum(c)})", lum(c) < 90)
    }

    @Test fun saturacionCeroDejaGrises() {
        val p = frame(one("red.mp4", look(sat = 0.0), "gray.mp4"), 1000).getPixel(300, 300)
        val mx = maxOf(p shr 16 and 255, p shr 8 and 255, p and 255); val mn = minOf(p shr 16 and 255, p shr 8 and 255, p and 255)
        assertTrue("gris (${p.toString(16)})", mx - mn < 30)
    }

    @Test fun zoomMedioDejaBordesNegrosYDesplaza() {
        val small = frame(one("red.mp4", look(scale = 0.5), "small.mp4"), 1000)
        assertTrue("centro rojo", near(small.getPixel(540, 960), 255, 0, 0))
        assertTrue("esquina negra (${lum(small.getPixel(20, 20))})", lum(small.getPixel(20, 20)) < 50)
        val moved = frame(one("red.mp4", look(scale = 0.5, px = 0.25), "moved.mp4"), 1000)
        assertTrue("rojo desplazado a la derecha", near(moved.getPixel(540 + 270, 960), 255, 0, 0))
        assertTrue("a la izquierda queda negro", lum(moved.getPixel(540 - 400, 960)) < 50)
        val down = frame(one("red.mp4", look(scale = 0.5, py = 0.25), "down.mp4"), 1000)
        assertTrue("py positivo baja el clip", near(down.getPixel(540, 960 + 480), 255, 0, 0) && lum(down.getPixel(540, 960 - 700)) < 50)
    }

    @Test fun giroHorarioLlevaLaIzquierdaArriba() {
        // split.mp4: mitad izquierda roja, derecha azul. Girar 90° en sentido horario deja el rojo arriba y el azul abajo.
        val out = one("split.mp4", look(rot = 90.0), "rot.mp4", dur = 2000)
        val f = frame(out, 800)
        assertTrue("rojo arriba (${f.getPixel(540, 600).toString(16)})", near(f.getPixel(540, 600), 255, 0, 0))
        assertTrue("azul abajo (${f.getPixel(540, 1300).toString(16)})", near(f.getPixel(540, 1300), 0, 0, 255))
        val mirror = frame(one("split.mp4", look(flip = true), "flip.mp4", dur = 2000), 800)
        assertTrue("espejo: el azul pasa a la izquierda", near(mirror.getPixel(200, 960), 0, 0, 255) && near(mirror.getPixel(900, 960), 255, 0, 0))
    }

    @Test fun pistaDeAudioConInicioPropio() {
        val music = asset("music.m4a")
        // clip mudo de 4 s y una pista que empieza a los 2 s y dura 1 s
        val out = one("red.mp4", look(), "aud.mp4", audios = listOf(EditorAudioSpec(music, 2000, 1000, 1f, 0, 0)), volume = 0f)
        val before = audioRms(out, 200, 1700); val during = audioRms(out, 2150, 2850); val after = audioRms(out, 3200, 3900)
        assertTrue("silencio antes ($before)", before < 60)
        assertTrue("suena desde 2 s ($during)", during > 300)
        assertTrue("se corta tras su duración ($after)", after < 60)
    }

    // ---------------------------------------------------------------- Fase 2
    @Test fun animacionDeEncuadreDesplazaElClipDeInicioAFin() {
        val out = one("split.mp4", look(kPx = 0.5), "kf.mp4", dur = 2000)
        val a = frame(out, 120); val b = frame(out, 1800)
        assertTrue("al inicio el rojo está a la izquierda", near(a.getPixel(100, 960), 255, 0, 0))
        assertTrue("al final el clip se desplazó: izquierda negra (${lum(b.getPixel(100, 960))})", lum(b.getPixel(100, 960)) < 60)
        assertTrue("y el rojo llegó a la derecha", near(b.getPixel(900, 960), 255, 0, 0))
    }

    @Test fun animacionDeTextoConFundido() {
        val style = TextStyle(fontSize = 220f, fontWeight = 900, color = "#FFFFFF", outline = false, shadow = false)
        val sp = EditorSpec("t", listOf(EditorClipSpec(asset("red.mp4"), 0, 4000, 1f, 0f)), listOf(EditorTextSpec("WWWW", style, 1_000_000, 3_000_000, "fade", 1.0)), null, 0.5f, 30, "rapida")
        val out = render(sp, "ta.mp4")
        val early = whitePixels(frame(out, 1100)); val mid = whitePixels(frame(out, 2000)); val late = whitePixels(frame(out, 2900))
        assertTrue("casi transparente al empezar ($early)", early < mid / 4)
        assertTrue("pleno a mitad ($mid)", mid > 2000)
        assertTrue("se desvanece al final ($late)", late < mid / 4)
    }
}
