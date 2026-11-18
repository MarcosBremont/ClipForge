package com.clipforge.android.editor

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.clipforge.android.data.EditorProjectEntity
import com.clipforge.android.data.VideoEntity
import com.clipforge.android.export.EditorClipSpec
import com.clipforge.android.export.EditorSpec
import com.clipforge.android.export.EditorTextSpec
import com.clipforge.android.export.ExportBatch
import com.clipforge.android.export.ExportItem
import com.clipforge.android.export.ExportManager
import com.clipforge.android.export.ExportService
import com.clipforge.android.model.AppJson
import com.clipforge.android.model.Draft
import com.clipforge.android.services
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class SelKind { CLIP, TEXT, MUSIC }
data class Sel(val kind: SelKind, val id: String)

/** Estado del editor de video: proyecto, historial (deshacer/rehacer), selección, cabeza de reproducción y guardado automático. */
@OptIn(FlowPreview::class)
class EditorViewModel(app: Application) : AndroidViewModel(app) {
    private val dao = app.services.dao

    val project = MutableStateFlow(EditorProject())
    val sel = MutableStateFlow<Sel?>(null)
    val playhead = MutableStateFlow(0.0)
    val playing = MutableStateFlow(false)
    val seekTick = MutableStateFlow(0)
    val pps = MutableStateFlow(60f) // dp por segundo
    val canUndo = MutableStateFlow(false)
    val canRedo = MutableStateFlow(false)
    val saved = MutableStateFlow(false)
    val toast = MutableSharedFlow<String>(extraBufferCapacity = 8)

    val videos = dao.videos().map { l -> l.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    val projects = dao.editorProjects().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val past = ArrayDeque<EditorProject>()
    private val future = ArrayDeque<EditorProject>()
    private var lastJson = ""
    private var dirty = false

    init {
        viewModelScope.launch {
            // Recupera el último proyecto del editor al abrir la app.
            dao.lastEditorProject()?.let { load(it) }
            project.drop(1).debounce(800).collect { save(it) }
        }
    }

    private fun say(m: String) { toast.tryEmit(m) }
    private fun refreshFlags() { canUndo.value = past.isNotEmpty(); canRedo.value = future.isNotEmpty() }

    private suspend fun save(p: EditorProject) {
        if (!dirty) return
        if (p.clips.isEmpty() && p.texts.isEmpty() && p.id == 0L) return
        val json = AppJson.encodeToString(EditorProject.serializer(), p.copy(id = 0))
        if (json == lastJson) return
        val id = dao.upsertEditorProject(EditorProjectEntity(id = p.id, name = p.name.ifBlank { "Proyecto del editor" }, json = json, updatedAt = System.currentTimeMillis()))
        lastJson = json
        if (p.id == 0L) project.update { if (it.id == 0L) it.copy(id = id) else it }
        saved.value = true
    }

    private fun load(e: EditorProjectEntity) {
        val p = runCatching { AppJson.decodeFromString(EditorProject.serializer(), e.json) }.getOrNull() ?: run { say("No se pudo abrir el proyecto (datos dañados)."); return }
        past.clear(); future.clear(); refreshFlags()
        lastJson = e.json; dirty = false
        project.value = p.copy(id = e.id, name = e.name)
        sel.value = null; playhead.value = 0.0; playing.value = false; seekTick.value++; saved.value = true
    }

    fun open(id: Long) = viewModelScope.launch { dao.editorProject(id)?.let { load(it) } }
    fun delete(id: Long) = viewModelScope.launch { dao.deleteEditorProject(id); if (project.value.id == id) newProject() }
    fun newProject() {
        past.clear(); future.clear(); refreshFlags(); lastJson = ""; dirty = false
        project.value = EditorProject(); sel.value = null; playhead.value = 0.0; playing.value = false; seekTick.value++; saved.value = false
    }

    // ---------------------------------------------------------------- historial
    /** Cambio puntual: un paso de deshacer. */
    fun apply(fn: (EditorProject) -> EditorProject) {
        val cur = project.value; val next = fn(cur)
        if (next == cur) return
        past.addLast(cur); if (past.size > 100) past.removeFirst(); future.clear(); refreshFlags()
        dirty = true; saved.value = false; project.value = next; fixSel()
    }
    private var lastKey = ""; private var lastAt = 0L
    /** Cambios seguidos del mismo control (deslizadores): cuentan como un solo paso de deshacer. */
    fun edit(key: String, fn: (EditorProject) -> EditorProject) {
        val now = System.currentTimeMillis()
        if (key == lastKey && now - lastAt < 700) live(fn) else apply(fn)
        lastKey = key; lastAt = now
    }
    /** Inicio de un gesto de arrastre: guarda el estado anterior una sola vez. */
    fun beginGesture() { past.addLast(project.value); if (past.size > 100) past.removeFirst(); future.clear(); refreshFlags() }
    /** Cambio dentro de un gesto (sin crear pasos de deshacer). */
    fun live(fn: (EditorProject) -> EditorProject) {
        val next = fn(project.value)
        if (next != project.value) { dirty = true; saved.value = false; project.value = next }
    }
    fun undo() {
        val prev = past.removeLastOrNull() ?: return
        future.addFirst(project.value); project.value = prev; refreshFlags(); dirty = true; fixSel(); seekTick.value++
    }
    fun redo() {
        val next = future.removeFirstOrNull() ?: return
        past.addLast(project.value); project.value = next; refreshFlags(); dirty = true; fixSel(); seekTick.value++
    }
    private fun fixSel() {
        val s = sel.value ?: return
        val p = project.value
        val ok = when (s.kind) { SelKind.CLIP -> p.clips.any { it.id == s.id }; SelKind.TEXT -> p.texts.any { it.id == s.id }; SelKind.MUSIC -> p.music != null }
        if (!ok) sel.value = null
    }

    // ---------------------------------------------------------------- acciones
    fun select(s: Sel?) { sel.value = s }
    fun seek(t: Double) { playhead.value = t.coerceIn(0.0, totalDuration(project.value)); seekTick.value++ }
    fun setPlaying(v: Boolean) { playing.value = v }
    fun rename(name: String) { dirty = true; saved.value = false; project.update { it.copy(name = name) } }

    fun addVideo(v: VideoEntity, atPlayhead: Boolean = false) {
        var index = project.value.clips.size
        if (atPlayhead) locate(project.value, playhead.value)?.let { index = it.index + 1 }
        apply { addClip(it, v.id, v.duration, index) }
    }

    fun split() {
        val r = splitAt(project.value, playhead.value)
        if (r == null) say("No se puede dividir aquí: acércate al centro de un clip (mínimo 0,3 s a cada lado).")
        else { apply { r.project }; select(Sel(SelKind.CLIP, r.selectId)) }
    }

    fun addTextHere() {
        val p = project.value
        if (p.clips.isEmpty()) { say("Primero agrega un video a la línea de tiempo."); return }
        val r = addText(p, playhead.value, "Tu texto", p.texts.lastOrNull()?.style?.copy(y = 0.5f) ?: com.clipforge.android.model.TextStyle())
        apply { r.project }; select(Sel(SelKind.TEXT, r.selectId))
    }

    fun duplicateSelected() {
        val s = sel.value ?: return
        val r = when (s.kind) { SelKind.CLIP -> duplicateClip(project.value, s.id); SelKind.TEXT -> duplicateText(project.value, s.id); else -> null } ?: return
        apply { r.project }; select(Sel(s.kind, r.selectId))
    }

    fun deleteSelected() {
        val s = sel.value ?: return
        apply { when (s.kind) { SelKind.CLIP -> removeClip(it, s.id); SelKind.TEXT -> removeText(it, s.id); SelKind.MUSIC -> it.copy(music = null) } }
    }

    fun setMusic(uri: Uri, name: String) {
        try { getApplication<Application>().contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) { /* no necesario */ }
        apply { it.copy(music = EMusic(uri.toString(), name, 0.8)) }
        select(Sel(SelKind.MUSIC, "music"))
    }

    /** Convierte la selección automática del generador en un proyecto editable. */
    fun importDraft(d: Draft) {
        val plan = d.plan ?: return
        val p = fromPlan(plan.segments, d.text, d.style, d.settings.originalAudio, d.settings.fps, d.settings.quality, d.text.take(40).ifBlank { "Desde un video creado" })
            .let { pr -> if (d.settings.musicUri != null) pr.copy(music = EMusic(d.settings.musicUri, d.settings.musicName ?: "música", d.settings.musicVolume.toDouble())) else pr }
        past.clear(); future.clear(); refreshFlags(); lastJson = ""; dirty = true
        project.value = p; sel.value = null; playhead.value = 0.0; playing.value = false; seekTick.value++; saved.value = false
    }

    // ---------------------------------------------------------------- exportación
    fun export(onStarted: () -> Unit) = viewModelScope.launch {
        val p = project.value
        if (p.clips.isEmpty()) { say("La línea de tiempo está vacía."); return@launch }
        if (ExportManager.state.value.running) { say("Ya hay una exportación en curso."); return@launch }
        val vids = dao.videosByIds(p.clips.map { it.videoId }.distinct()).associateBy { it.id }
        val clips = p.clips.map { c ->
            val v = vids[c.videoId] ?: run { say("Un clip usa un video que ya no está en la biblioteca."); return@launch }
            EditorClipSpec(v.uri, (c.srcStart * 1000).toLong(), (minOf(c.srcEnd, v.duration) * 1000).toLong(), c.speed.toFloat(), c.volume.toFloat())
        }
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val spec = EditorSpec(
            "ClipForge_Editor_$stamp", clips,
            p.texts.map { EditorTextSpec(it.text, it.style, (it.start * 1_000_000).toLong(), ((it.start + it.duration) * 1_000_000).toLong()) },
            p.music?.uri, (p.music?.volume ?: 0.8).toFloat(), p.fps, p.quality
        )
        ExportService.start(getApplication(), ExportBatch(0, listOf(ExportItem(spec.name, totalDuration(p), emptyList()) { ex, out, prog -> ex.renderEditor(spec, out, prog) })))
        onStarted()
    }
}
