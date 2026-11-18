package com.clipforge.android

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clipforge.android.data.AppDatabase
import com.clipforge.android.export.ExportClip
import com.clipforge.android.export.ExportSpec
import com.clipforge.android.export.Exporter
import com.clipforge.android.library.Candidate
import com.clipforge.android.library.LibraryImporter
import com.clipforge.android.model.GenSettings
import com.clipforge.android.model.TextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Pruebas reales en un dispositivo/emulador: exportación con Transformer e importación de la biblioteca. */
@RunWith(AndroidJUnit4::class)
class EngineInstrumentedTest {
    private lateinit var ctx: Context
    private lateinit var dir: File

    @Before fun setUp() {
        ctx = InstrumentationRegistry.getInstrumentation().targetContext
        dir = File(ctx.cacheDir, "engine-test").apply { deleteRecursively(); mkdirs() }
    }

    private fun asset(name: String): File {
        val f = File(dir, name)
        InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { i -> f.outputStream().use { i.copyTo(it) } }
        return f
    }

    private fun whitePixelsAtCenter(video: File, atMs: Long): Int {
        val m = MediaMetadataRetriever()
        m.setDataSource(video.absolutePath)
        val bmp: Bitmap = m.getFrameAtTime(atMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST)!!
        m.release()
        File(ctx.cacheDir, video.name + ".png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        var n = 0
        val y0 = bmp.height * 45 / 100; val y1 = bmp.height * 55 / 100
        for (y in y0 until y1 step 2) for (x in 0 until bmp.width step 2) {
            val p = bmp.getPixel(x, y)
            if ((p shr 16 and 255) > 245 && (p shr 8 and 255) > 245 && (p and 255) > 245) n++
        }
        return n
    }

    private fun render(spec: ExportSpec, name: String): File {
        val out = File(dir, name)
        runBlocking { withContext(Dispatchers.Main) { Exporter(ctx).render(spec, out) { } } }
        return out
    }

    @Test fun exportaVerticalConTextoYMusica() {
        val land = asset("landscape.mp4"); val port = asset("portrait.mp4"); val music = asset("music.m4a")
        val clips = listOf(
            ExportClip(Uri.fromFile(land).toString(), 2000, 1500),   // horizontal → debe recortarse a 9:16
            ExportClip(Uri.fromFile(port).toString(), 1000, 1200),   // vertical sin audio
            ExportClip(Uri.fromFile(land).toString(), 7000, 1300)
        )
        val expectedMs = 1500 + 1200 + 1300
        val settings = GenSettings(duration = 4, originalAudio = true, musicUri = Uri.fromFile(music).toString(), musicVolume = 0.5f, fps = 30)
        val withText = render(ExportSpec("t1", clips, "HOLA MUNDO", TextStyle(fontSize = 120f), settings), "con_texto.mp4")
        val noText = render(ExportSpec("t2", clips, "", TextStyle(), settings.copy(musicUri = null, originalAudio = false)), "sin_texto.mp4")

        // Dimensiones y duración
        val m = MediaMetadataRetriever(); m.setDataSource(withText.absolutePath)
        val ow = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)!!.toInt(); val oh = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)!!.toInt(); val rot = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
        val swap = rot == "90" || rot == "270"
        assertTrue("dimensiones ${ow}x$oh rot=$rot (esperado 1080x1920)", (if (swap) oh else ow) == 1080 && (if (swap) ow else oh) == 1920)
        val dur = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong()
        assertTrue("duración $dur ms, esperada ~$expectedMs", kotlin.math.abs(dur - expectedMs) < 300)
        m.release()

        // Códecs: H.264 + AAC
        val ex = MediaExtractor(); ex.setDataSource(withText.absolutePath)
        val mimes = (0 until ex.trackCount).map { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME) }
        ex.release()
        assertTrue("falta H.264: $mimes", "video/avc" in mimes)
        assertTrue("falta AAC: $mimes", "audio/mp4a-latm" in mimes)

        // El texto realmente se dibuja en el centro del fotograma
        val a = whitePixelsAtCenter(withText, 500); val b = whitePixelsAtCenter(noText, 500)
        assertTrue("el texto no aparece (píxeles blancos con texto=$a, sin texto=$b)", a > b + 400)

        // Sin audio original ni música sigue habiendo pista AAC (silencio): reproducible en cualquier app
        val ex2 = MediaExtractor(); ex2.setDataSource(noText.absolutePath)
        val mimes2 = (0 until ex2.trackCount).map { ex2.getTrackFormat(it).getString(MediaFormat.KEY_MIME) }
        ex2.release()
        assertTrue("sin pista de audio en la versión muda: $mimes2", "audio/mp4a-latm" in mimes2)
    }

    @Test fun importaBibliotecaYDetectaDuplicados() = runBlocking {
        val db = Room.inMemoryDatabaseBuilder(ctx, AppDatabase::class.java).build()
        try {
            val imp = LibraryImporter(ctx, db.dao())
            val a = asset("landscape.mp4")
            val copy = File(dir, "copia.mp4").also { a.copyTo(it, overwrite = true) }
            val p = asset("portrait.mp4")
            val cands = listOf(a, copy, p).map { Candidate(Uri.fromFile(it), it.name, it.length(), "test") }
            val r = imp.import(cands) { _, _, _ -> }
            assertEquals(3, r.added); assertEquals(1, r.duplicates); assertEquals(0, r.failed)
            val all = db.dao().usableVideos()
            assertEquals("el duplicado no debe usarse para crear", 2, all.size)
            val v = all.first { it.width == 1920 } // el original depende del orden de llegada; solo importa que sea el horizontal
            assertEquals(1920, v.width); assertEquals(1080, v.height)
            assertEquals(12.0, v.duration, 0.2)
            assertTrue(v.hasAudio)
            assertTrue("miniatura creada", v.thumb != null && File(v.thumb!!).length() > 1000)
            // Reimportar lo mismo no duplica filas
            val r2 = imp.import(cands) { _, _, _ -> }
            assertEquals(3, r2.skipped)
        } finally { db.close() }
    }
}
