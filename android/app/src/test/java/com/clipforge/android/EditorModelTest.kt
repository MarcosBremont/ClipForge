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

    private fun one(d: Double = 10.0) = addClip(EditorProject(), 1, d)

    @Test fun aspectoSeLimitaYClipLookDaValoresDeFabrica() {
        var p = one()
        val id = p.clips[0].id
        val l0 = clipLook(p.clips[0])
        assertEquals(1.0, l0.scale, 0.0); assertEquals(1.0, l0.contrast, 0.0); assertEquals(0.0, l0.rot, 0.0); assertFalse(l0.flip)
        assertFalse(hasColor(p.clips[0])); assertFalse(hasFrame(p.clips[0]))
        p = setClip(p, id, scale = 99.0, rot = 400.0, sat = -3.0, bright = 2.0, px = 5.0)
        val l = clipLook(p.clips[0])
        assertEquals(4.0, l.scale, 0.0); assertEquals(180.0, l.rot, 0.0); assertEquals(0.0, l.sat, 0.0); assertEquals(0.5, l.bright, 0.0); assertEquals(1.0, l.px, 0.0)
        assertTrue(hasColor(p.clips[0])); assertTrue(hasFrame(p.clips[0]))
    }

    @Test fun fundidosNoPasanDeLaMitad() {
        var p = one(1.0)
        p = setClip(p, p.clips[0].id, fadeIn = 3.0, fadeOut = 3.0)
        assertEquals(0.5, clipLook(p.clips[0]).fadeIn, 0.002); assertEquals(0.5, clipLook(p.clips[0]).fadeOut, 0.002)
    }

    @Test fun filtrosAjustanLosCuatroParametros() {
        var p = one(5.0)
        p = applyFilter(p, p.clips[0].id, "bw")
        assertEquals("bw", p.clips[0].filter); assertEquals(0.0, p.clips[0].sat, 0.0)
        p = applyFilter(p, p.clips[0].id, "none")
        assertFalse(hasColor(p.clips[0]))
        assertSame(p, applyFilter(p, p.clips[0].id, "inventado"))
    }

    @Test fun transicionAmbosLadosYCero() {
        var p = addClip(addClip(EditorProject(), 1, 4.0), 2, 4.0)
        p = setTransition(p, 0, 0.6)
        assertEquals(0.6, transitionAt(p, 0), 0.002); assertEquals(0.6, p.clips[0].fadeOut, 0.002); assertEquals(0.6, p.clips[1].fadeIn, 0.002)
        p = setTransition(p, 0, 0.0)
        assertEquals(0.0, transitionAt(p, 0), 0.0)
        assertSame(p, setTransition(p, 1, 1.0))
    }

    @Test fun audiosSeAgreganMuevenRecortanYQuitan() {
        var p = one()
        val r = addAudio(p, "content://a", "a", "sfx", 8.0, 5.0) // solo caben 2 s
        p = r.project
        assertEquals(8.0, p.audios[0].start, 0.002); assertEquals(2.0, p.audios[0].duration, 0.002)
        p = moveAudio(p, r.selectId, 99.0); assertEquals(8.0, p.audios[0].start, 0.002)
        p = moveAudio(p, r.selectId, 1.0); assertEquals(1.0, p.audios[0].start, 0.002)
        p = setAudio(p, r.selectId, duration = 1.0, fadeIn = 5.0, volume = 3.0)
        assertEquals(0.5, p.audios[0].fadeIn, 0.002); assertEquals(1.0, p.audios[0].volume, 0.0)
        p = removeAudio(p, r.selectId); assertEquals(0, p.audios.size)
    }

    @Test fun normalizeRecortaAudiosYLosQuitaSiQuedaVacio() {
        var p = one()
        p = addAudio(p, "content://a", "a", "voice", 2.0).project // 2..10
        p = trimClip(p, p.clips[0].id, false, 5.0, 10.0)
        assertEquals(3.0, p.audios[0].duration, 0.002)
        p = removeClip(p, p.clips[0].id)
        assertEquals(0, p.audios.size)
    }

    @Test fun proyectosViejosSinAspectoNiAudiosSeAbren() {
        val old = """{"id":0,"name":"x","clips":[{"id":"c1","videoId":1,"srcStart":0.0,"srcEnd":5.0}],"texts":[],"fps":30,"quality":"media"}"""
        val p = com.clipforge.android.model.AppJson.decodeFromString(EditorProject.serializer(), old)
        assertEquals(1.0, p.clips[0].scale, 0.0); assertEquals(0, p.audios.size)
        val s = com.clipforge.android.model.AppJson.encodeToString(EditorProject.serializer(), setClip(p, "c1", scale = 2.0, filter = "warm"))
        assertEquals(2.0, com.clipforge.android.model.AppJson.decodeFromString(EditorProject.serializer(), s).clips[0].scale, 0.0)
    }

    @Test fun splitCaptionsCortaPorPalabrasYPuntuacion() {
        assertEquals(listOf("Hola mundo.", "Esto es una prueba", "de subtitulos largos para", "el video"), splitCaptions("Hola mundo. Esto es una prueba de subtitulos largos para el video", 4))
        assertEquals(emptyList<String>(), splitCaptions("  ", 4))
        assertEquals(listOf("uno"), splitCaptions("uno", 4))
    }

    @Test fun captionsRepartenSinHuecosNiSolapes() {
        val p = addClip(EditorProject(), 1, 10.0)
        val r = captionsFromText(p, "Primera frase corta. Segunda frase un poco mas larga que la primera. Tercera.", TextStyle(), 2.0, 8.0, 4)!!
        val ts = r.project.texts
        assertTrue(ts.size >= 3)
        assertEquals(2.0, ts[0].start, 0.002)
        for (i in 1 until ts.size) assertEquals(ts[i - 1].start + ts[i - 1].duration, ts[i].start, 0.003)
        assertEquals(8.0, ts.last().start + ts.last().duration, 0.003)
        assertNull(captionsFromText(EditorProject(), "hola", TextStyle()))
    }

    @Test fun movimientosCreanYQuitanAnimacionesYFrameAtInterpola() {
        var p = one()
        val id = p.clips[0].id
        assertFalse(clipLook(p.clips[0]).animated)
        p = applyMotion(p, id, "zoomIn")
        assertTrue(clipLook(p.clips[0]).animated); assertTrue(hasFrame(p.clips[0]))
        val l = clipLook(p.clips[0])
        assertEquals(1.0, frameAt(l, 0.0).first, 0.002); assertEquals(1.15, frameAt(l, 0.5).first, 0.002); assertEquals(1.3, frameAt(l, 1.0).first, 0.002); assertEquals(1.3, frameAt(l, 5.0).first, 0.002)
        p = applyMotion(p, id, "panLeft")
        val l2 = clipLook(p.clips[0])
        assertEquals(0.1, frameAt(l2, 0.0).second, 0.002); assertEquals(-0.1, frameAt(l2, 1.0).second, 0.002); assertEquals(0.0, frameAt(l2, 0.5).second, 0.002)
        p = applyMotion(p, id, "none")
        assertFalse(clipLook(p.clips[0]).animated)
        p = setClip(p, id, kScale = 3.0)
        assertTrue(clipLook(p.clips[0]).animated); assertEquals(3.0, p.clips[0].kScale!!, 0.0)
    }

    @Test fun textAnimEntraYSaleConFundidoYDeslizamiento() {
        var p = one()
        val r = addText(p, 2.0, "hola"); p = r.project
        val s0 = textAnim(p.texts[0], 3.0)
        assertEquals(1.0, s0.alpha, 0.0); assertEquals(0.0, s0.dy, 0.0)
        p = setText(p, r.selectId, anim = "up", animDur = 0.5, duration = 4.0)
        val t = p.texts[0]
        assertEquals(0.5, animLen(t), 0.002)
        var a = textAnim(t, 2.0); assertEquals(0.0, a.alpha, 0.002); assertEquals(120.0, a.dy, 0.002)
        a = textAnim(t, 2.25); assertEquals(0.5, a.alpha, 0.002); assertEquals(60.0, a.dy, 0.002)
        a = textAnim(t, 4.0); assertEquals(1.0, a.alpha, 0.002); assertEquals(0.0, a.dy, 0.002)
        a = textAnim(t, 5.75); assertEquals(0.5, a.alpha, 0.002); assertEquals(-60.0, a.dy, 0.002)
        p = setText(p, r.selectId, anim = "left"); assertEquals(120.0, textAnim(p.texts[0], 2.0).dx, 0.002)
        p = setText(p, r.selectId, anim = "fade", duration = 0.4); assertEquals(0.2, animLen(p.texts[0]), 0.002)
    }

    @Test fun addStickerCreaEmojiGrandeAnimado() {
        val t = addSticker(one(), 1.0, "🔥").project.texts[0]
        assertEquals("🔥", t.text); assertEquals("up", t.anim); assertTrue(t.style.fontSize >= 150f); assertFalse(t.style.outline)
    }
}
