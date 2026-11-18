package com.clipforge.android

import com.clipforge.android.editor.*
import com.clipforge.android.model.Segment
import com.clipforge.android.model.TextStyle
import org.junit.Assert.*
import org.junit.Test

class EditorModelTest {
    private fun base(): EditorProject = addClip(addClip(EditorProject(), 1, 10.0), 2, 6.0) // 0–10, 10–16

    @Test fun duracionTotalRespetaVelocidad() {
        var p = base()
        assertEquals(16.0, totalDuration(p), 0.002)
        p = setClip(p, p.clips[0].id, speed = 2.0)
        assertEquals(11.0, totalDuration(p), 0.002)
        p = setClip(p, p.clips[1].id, speed = 0.5)
        assertEquals(17.0, totalDuration(p), 0.002)
        assertEquals(12.0, clipDur(p.clips[1]), 0.002)
    }

    @Test fun velocidadYVolumenSeLimitan() {
        val p = base()
        assertEquals(4.0, setClip(p, p.clips[0].id, speed = 99.0).clips[0].speed, 0.0)
        assertEquals(0.25, setClip(p, p.clips[0].id, speed = 0.0).clips[0].speed, 0.0)
        assertEquals(1.0, setClip(p, p.clips[0].id, volume = 3.0).clips[0].volume, 0.0)
        assertEquals(0.0, setClip(p, p.clips[0].id, volume = -1.0).clips[0].volume, 0.0)
    }

    @Test fun cortarDivideSinPerderTiempo() {
        val r = splitAt(base(), 4.0)!!
        assertEquals(3, r.project.clips.size)
        assertEquals(16.0, totalDuration(r.project), 0.002)
        assertEquals(4.0, r.project.clips[0].srcEnd, 0.002)
        assertEquals(4.0, r.project.clips[1].srcStart, 0.002)
        assertEquals(r.project.clips[1].id, r.selectId)
    }

    @Test fun cortarClipAceleradoUsaInstanteDelOriginal() {
        var p = base()
        p = setClip(p, p.clips[0].id, speed = 2.0)
        val r = splitAt(p, 2.0)!! // 2 s de pantalla = 4 s del original
        assertEquals(4.0, r.project.clips[0].srcEnd, 0.002)
        assertEquals(11.0, totalDuration(r.project), 0.002)
    }

    @Test fun noCortaCercaDeUnBorde() {
        val p = base()
        assertNull(splitAt(p, 0.1)); assertNull(splitAt(p, 9.9)); assertNull(splitAt(EditorProject(), 1.0))
    }

    @Test fun recortarRespetaMinimoYOriginal() {
        var p = base()
        val id = p.clips[0].id
        p = trimClip(p, id, true, 3.0, 10.0)
        assertEquals(3.0, p.clips[0].srcStart, 0.002); assertEquals(13.0, totalDuration(p), 0.002)
        p = trimClip(p, id, false, 99.0, 10.0)
        assertEquals(10.0, p.clips[0].srcEnd, 0.002)
        p = trimClip(p, id, false, 3.01, 10.0)
        assertEquals(MIN_CLIP, clipDur(p.clips[0]), 0.002)
        p = trimClip(p, id, true, -5.0, 10.0)
        assertEquals(0.0, p.clips[0].srcStart, 0.0)
    }

    @Test fun moverDuplicarBorrar() {
        var p = base()
        val (a, b) = p.clips.map { it.id }
        p = moveClip(p, 0, 1)
        assertEquals(listOf(b, a), p.clips.map { it.id })
        val d = duplicateClip(p, a)!!
        assertEquals(3, d.project.clips.size)
        p = removeClip(d.project, b)
        assertEquals(2, p.clips.size)
        assertEquals(clipDur(p.clips[0]), clipStarts(p)[1], 0.002)
    }

    @Test fun locateConVelocidad() {
        var p = base()
        p = setClip(p, p.clips[1].id, speed = 2.0) // 3 s en pantalla, 6 s de video
        val l = locate(p, 11.0)!!
        assertEquals(1, l.index); assertEquals(10.0, l.start, 0.002); assertEquals(2.0, l.src, 0.002)
        assertEquals(1, locate(p, 9999.0)!!.index)
        assertNull(locate(EditorProject(), 1.0))
    }

    @Test fun textosSeMantienenDentroDeLaDuracion() {
        var p = base()
        p = addText(p, 12.0, "hola").project
        assertTrue(p.texts[0].start + p.texts[0].duration <= 16.0 + 1e-6)
        p = removeClip(p, p.clips[1].id) // total 10
        val t = p.texts[0]
        assertTrue(t.start <= 10 - 0.3 + 1e-6 && t.start + t.duration <= 10 + 1e-6)
        p = removeClip(p, p.clips[0].id)
        assertEquals(0, p.texts.size)
    }

    @Test fun textoAnadirMoverRedimensionarDuplicarBorrar() {
        var p = base()
        val r = addText(p, 2.0, "uno"); p = r.project; val id = r.selectId
        assertEquals(2.0, p.texts[0].start, 0.002); assertEquals(3.0, p.texts[0].duration, 0.002)
        p = moveText(p, id, 100.0); assertEquals(13.0, p.texts[0].start, 0.002)
        p = moveText(p, id, -5.0); assertEquals(0.0, p.texts[0].start, 0.002)
        p = resizeText(p, id, false, 8.0); assertEquals(8.0, p.texts[0].duration, 0.002)
        p = resizeText(p, id, true, 2.0)
        assertEquals(2.0, p.texts[0].start, 0.002); assertEquals(8.0, p.texts[0].start + p.texts[0].duration, 0.002)
        p = resizeText(p, id, false, 2.05); assertEquals(0.3, p.texts[0].duration, 0.002)
        val d = duplicateText(p, id)!!
        assertEquals(2, d.project.texts.size)
        assertTrue(d.project.texts[1].style.y > d.project.texts[0].style.y)
        assertEquals(1, removeText(d.project, id).texts.size)
    }

    @Test fun textsAtVariosALaVez() {
        var p = base()
        p = addText(p, 1.0, "a").project
        p = addText(p, 2.0, "b").project
        assertEquals(emptyList<String>(), textsAt(p, 0.5).map { it.text })
        assertEquals(listOf("a", "b"), textsAt(p, 2.5).map { it.text })
        assertEquals(listOf("b"), textsAt(p, 4.5).map { it.text })
    }

    @Test fun setTextCambiaEstiloSinTocarElResto() {
        val r = addText(base(), 0.0, "x", TextStyle(x = 0.5f, y = 0.5f))
        val p = setText(r.project, r.selectId, text = "nuevo", style = { it.copy(x = 0.2f, y = 0.8f, fontSize = 100f) })
        assertEquals("nuevo", p.texts[0].text); assertEquals(0.2f, p.texts[0].style.x, 1e-6f); assertEquals(0.8f, p.texts[0].style.y, 1e-6f)
        assertEquals(TextStyle().color, p.texts[0].style.color)
    }

    @Test fun snapSoloDentroDelUmbral() {
        assertEquals(3.0, snap(3.04, listOf(0.0, 3.0, 10.0), 0.1), 0.0)
        assertEquals(3.5, snap(3.5, listOf(0.0, 3.0, 10.0), 0.1), 0.0)
    }

    @Test fun fromPlanCreaClipsYTexto() {
        val p = fromPlan(listOf(Segment("a", 1, 5.0, 2.0), Segment("b", 2, 0.0, 3.0)), "hola", TextStyle(), false, 30, "media")
        assertEquals(2, p.clips.size); assertEquals(5.0, totalDuration(p), 0.002)
        assertEquals(0.0, p.clips[0].volume, 0.0)
        assertEquals(1, p.texts.size); assertEquals(5.0, p.texts[0].duration, 0.002)
    }

    @Test fun normalizeEsIdempotente() {
        val p = normalize(addText(base(), 3.0, "a").project)
        assertEquals(p, normalize(p))
    }

    @Test fun serializaYDeserializa() {
        val p = addText(base(), 1.0, "ñandú").project.copy(music = EMusic("content://x", "m.mp3", 0.5))
        val s = com.clipforge.android.model.AppJson.encodeToString(EditorProject.serializer(), p)
        assertEquals(p, com.clipforge.android.model.AppJson.decodeFromString(EditorProject.serializer(), s))
    }
}
