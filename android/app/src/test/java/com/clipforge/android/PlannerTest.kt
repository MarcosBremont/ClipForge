package com.clipforge.android

import com.clipforge.android.model.GenSettings
import com.clipforge.android.model.Plan
import com.clipforge.android.model.Segment
import com.clipforge.android.planner.*
import org.junit.Assert.*
import org.junit.Test

class PlannerTest {
    private val videos = (1L..8L).map { PVideo(it, 40.0 + it * 12) }

    @Test fun mulberry32_coincideConLaVersionDeEscritorio() {
        // Valores calculados con la implementación TypeScript de src/shared/planner.ts (semilla 42).
        val r = mulberry32(42)
        val esperado = doubleArrayOf(0.6011037519, 0.4482905590, 0.8524657935, 0.6697340414)
        for (e in esperado) assertEquals(e, r(), 1e-9)
    }

    @Test fun lasDuracionesSumanExactamenteLoPedido() {
        for (d in listOf(10, 15, 23, 30, 45, 60)) for (seed in 1L..20L) {
            val t = resolveTimings(GenSettings(duration = d), mulberry32(seed))
            assertEquals("duración $d semilla $seed", d.toDouble(), t.sum(), 0.06)
            assertTrue(t.all { it >= 0.4 })
        }
    }

    @Test fun esDeterministaPorSemilla() {
        val a = makePlan(PlanInput(videos, GenSettings(duration = 20), emptyList(), seed = 7))
        val b = makePlan(PlanInput(videos, GenSettings(duration = 20), emptyList(), seed = 7))
        assertEquals(a.segments.map { it.videoId to it.start }, b.segments.map { it.videoId to it.start })
        val c = makePlan(PlanInput(videos, GenSettings(duration = 20), emptyList(), seed = 8))
        assertNotEquals(a.segments.map { it.videoId to it.start }, c.segments.map { it.videoId to it.start })
    }

    @Test fun losFragmentosNoSeSolapanNiSalenDelVideo() {
        for (seed in 1L..50L) {
            val p = makePlan(PlanInput(videos, GenSettings(duration = 30), emptyList(), seed = seed))
            val byVideo = p.segments.groupBy { it.videoId }
            for ((id, segs) in byVideo) {
                val dur = videos.first { it.id == id }.duration
                val sorted = segs.sortedBy { it.start }
                for (s in sorted) assertTrue(s.start >= 0 && s.start + s.duration <= dur)
                for (i in 1 until sorted.size) assertTrue("solape en semilla $seed", sorted[i].start >= sorted[i - 1].start + sorted[i - 1].duration)
            }
            assertEquals(30.0, totalDuration(p.segments), 0.06)
        }
    }

    @Test fun noSoloUsaElInicioDeLosVideos() {
        val starts = (1L..30L).flatMap { makePlan(PlanInput(videos, GenSettings(duration = 20), emptyList(), seed = it)).segments }.map { it.start }
        assertTrue("debe haber fragmentos más allá de los 20 s", starts.count { it > 20 } > starts.size / 4)
    }

    @Test fun evitaLoUsadoEnProyectosAnteriores() {
        val first = makePlan(PlanInput(videos, GenSettings(duration = 20), emptyList(), seed = 3))
        val used = first.segments.map { Range(it.videoId, it.start, it.duration) }
        val second = makePlan(PlanInput(videos, GenSettings(duration = 20), used, seed = 4))
        for (s in second.segments) for (u in used) if (u.videoId == s.videoId)
            assertFalse("repite un fragmento", s.start < u.start + u.duration && u.start < s.start + s.duration)
    }

    @Test fun replaceSegmentCambiaSoloEseFragmento() {
        val p = makePlan(PlanInput(videos, GenSettings(duration = 20), emptyList(), seed = 5))
        val q = replaceSegment(p, 1, videos, emptyList(), 99)
        assertEquals(p.segments.size, q.segments.size)
        assertEquals(p.segments[0].start, q.segments[0].start, 0.0)
        assertEquals(p.segments[1].duration, q.segments[1].duration, 0.0)
        assertTrue(p.segments[1].videoId != q.segments[1].videoId || p.segments[1].start != q.segments[1].start)
    }

    @Test fun addSegmentAnadeUno() {
        val p = makePlan(PlanInput(videos, GenSettings(duration = 15), emptyList(), seed = 6))
        assertEquals(p.segments.size + 1, addSegment(p, 1.5, videos, emptyList(), 1).segments.size)
    }

    @Test fun comboKeyEsEstableYSensibleAlOrden() {
        val s = listOf(Segment("a", 1, 3.0, 1.0), Segment("b", 2, 9.5, 1.0))
        assertEquals(comboKey(s), comboKey(s.reversed()))
        assertNotEquals(comboKey(s), comboKey(listOf(Segment("a", 1, 3.0, 1.0), Segment("b", 2, 12.0, 1.0))))
    }

    @Test fun conVideosCortosAcortaEnLugarDeFallar() {
        val short = listOf(PVideo(1, 2.0))
        val p = makePlan(PlanInput(short, GenSettings(duration = 10), emptyList(), seed = 1))
        assertTrue(p.segments.isNotEmpty())
        assertTrue(p.segments.all { it.start + it.duration <= 2.0 })
    }

    @Test fun regenerateCambiaLaSeleccion() {
        val inp = PlanInput(videos, GenSettings(duration = 20), emptyList(), seed = 10)
        val a: Plan = makePlan(inp)
        val b: Plan = regenerate(inp)
        assertNotEquals(a.seed, b.seed)
        assertNotEquals(a.segments.map { it.start }, b.segments.map { it.start })
    }
}
