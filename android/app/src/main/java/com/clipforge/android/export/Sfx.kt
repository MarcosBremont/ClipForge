package com.clipforge.android.export

import android.content.Context
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/** Efectos de sonido incluidos: se sintetizan en el teléfono (sin descargas ni derechos de autor) como WAV mono de 16 bits. */
data class Sfx(val id: String, val name: String, val duration: Double, val file: File)

object SfxLibrary {
    const val RATE = 44100
    private class St(var lp: Double = 0.0, var seed: Long = 12345)
    private fun noise(st: St): Double { st.seed = (st.seed * 1664525L + 1013904223L) and 0xFFFFFFFFL; return st.seed / 2147483648.0 - 1 }
    private fun env(t: Double, d: Double, a: Double = 0.005) = min(1.0, t / a) * max(0.0, 1 - t / d)

    private class Def(val id: String, val name: String, val dur: Double, val gen: (Double, St) -> Double)

    private val defs = listOf(
        Def("pop", "Pop", 0.18) { t, _ -> sin(2 * PI * (900 - 3200 * t) * t) * env(t, 0.18, 0.002) * 0.9 },
        Def("ding", "Ding", 1.2) { t, _ -> (sin(2 * PI * 1318 * t) + 0.4 * sin(2 * PI * 2636 * t)) * exp(-4 * t) * 0.5 * min(1.0, t / 0.002) },
        Def("whoosh", "Whoosh", 0.9) { t, st -> val f = 0.02 + 0.5 * sin(PI * t / 0.9).pow(2); st.lp += f * (noise(st) - st.lp); st.lp * 2.4 * sin(PI * t / 0.9) },
        Def("boom", "Impacto", 1.0) { t, st -> (sin(2 * PI * (70 - 40 * t) * t) * 0.9 + noise(st) * 0.25 * exp(-14 * t)) * exp(-3.5 * t) * min(1.0, t / 0.002) },
        Def("click", "Clic", 0.06) { t, st -> noise(st) * exp(-120 * t) * 0.8 },
        Def("riser", "Subida", 1.5) { t, _ -> sin(2 * PI * (250 + 900 * t) * t) * min(1.0, t / 0.05) * min(1.0, (1.5 - t) / 0.05) * 0.45 }
    )

    val ids: List<String> get() = defs.map { it.id }

    /** Muestras PCM de 16 bits de un efecto (puro: se puede probar sin Android). */
    fun samples(id: String): ShortArray {
        val d = defs.first { it.id == id }
        val n = (d.dur * RATE).toInt()
        val st = St()
        return ShortArray(n) { i -> (d.gen(i.toDouble() / RATE, st).coerceIn(-1.0, 1.0) * 32767).toInt().toShort() }
    }

    fun wav(samples: ShortArray): ByteArray {
        val data = samples.size * 2
        val b = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()); b.putInt(36 + data); b.put("WAVEfmt ".toByteArray()); b.putInt(16)
        b.putShort(1); b.putShort(1); b.putInt(RATE); b.putInt(RATE * 2); b.putShort(2); b.putShort(16)
        b.put("data".toByteArray()); b.putInt(data)
        for (s in samples) b.putShort(s)
        return b.array()
    }

    /** Genera (si faltan) los efectos en la carpeta privada de la app y devuelve la lista. */
    fun ensure(ctx: Context): List<Sfx> {
        val dir = File(ctx.filesDir, "sfx").apply { mkdirs() }
        return defs.map { d ->
            val f = File(dir, "${d.id}.wav")
            if (!f.exists() || f.length() < 100) f.writeBytes(wav(samples(d.id)))
            Sfx(d.id, d.name, d.dur, f)
        }
    }
}
