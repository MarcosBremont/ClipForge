package com.clipforge.android

import com.clipforge.android.export.SfxLibrary
import org.junit.Assert.*
import org.junit.Test

class SfxTest {
    @Test fun cadaEfectoSuenaTieneLargoYWavValido() {
        assertEquals(6, SfxLibrary.ids.size)
        for (id in SfxLibrary.ids) {
            val s = SfxLibrary.samples(id)
            assertTrue("$id sin muestras", s.size > 1000)
            assertTrue("$id en silencio", s.maxOf { Math.abs(it.toInt()) } > 3000)
            val w = SfxLibrary.wav(s)
            assertEquals("RIFF", String(w, 0, 4)); assertEquals("WAVE", String(w, 8, 4)); assertEquals(44 + s.size * 2, w.size)
        }
    }
}
