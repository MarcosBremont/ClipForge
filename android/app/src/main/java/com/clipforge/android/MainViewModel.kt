package com.clipforge.android

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.clipforge.android.ai.AiClient
import com.clipforge.android.data.*
import com.clipforge.android.export.*
import com.clipforge.android.library.Candidate
import com.clipforge.android.model.*
import com.clipforge.android.planner.*
import com.clipforge.android.update.Release
import com.clipforge.android.update.Updater
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class ImportUi(val running: Boolean, val done: Int, val total: Int, val current: String, val message: String? = null)

sealed interface UpdateUi {
    data object Idle : UpdateUi
    data object Checking : UpdateUi
    data object None : UpdateUi
    data class Available(val release: Release) : UpdateUi
    data class Downloading(val percent: Int) : UpdateUi
    data class Ready(val release: Release, val file: File) : UpdateUi
    data class Error(val message: String) : UpdateUi
}

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val svc = app.services
    private val dao = svc.dao
    val ai = AiClient(svc)

    // ---------------------------------------------------------------- datos observables
    val videos = dao.videos().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val videoMap = videos.map { l -> l.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    val stats = dao.stats().stateIn(viewModelScope, SharingStarted.Eagerly, LibraryStats(0, 0, 0, 0.0))
    val projects = dao.projects().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val outputs = dao.outputs().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val templates = dao.templates().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val export = ExportManager.state

    val importUi = MutableStateFlow<ImportUi?>(null)
    val busy = MutableStateFlow<String?>(null)
    val toast = MutableSharedFlow<String>(extraBufferCapacity = 8)
    private var importJob: Job? = null

    // ---------------------------------------------------------------- borrador (autoguardado y recuperación)
    val draft = MutableStateFlow(Draft())
    val recovered = MutableStateFlow(false)
    private var lastSaved = ""

    init {
        viewModelScope.launch {
            dao.lastProject()?.let { p ->
                runCatching { AppJson.decodeFromString<Draft>(p.draftJson) }.getOrNull()?.let {
                    draft.value = it.copy(projectId = p.id); lastSaved = p.draftJson; recovered.value = it.text.isNotBlank() || it.plan != null
                }
            }
            draft.debounce(700).collect { saveDraft(it) }
        }
    }

    private suspend fun saveDraft(d: Draft) {
        if (d.projectId == 0L && d.text.isBlank() && d.plan == null) return // no guardar borradores vacíos
        val json = AppJson.encodeToString(d.copy(projectId = 0))
        if (json == lastSaved) return
        val name = d.text.trim().lineSequence().firstOrNull()?.take(40)?.ifBlank { null } ?: "Proyecto sin título"
        val id = withContext(Dispatchers.IO) { dao.upsertProject(ProjectEntity(id = d.projectId, name = name, draftJson = json, updatedAt = System.currentTimeMillis())) }
        lastSaved = json
        if (d.projectId == 0L) draft.update { if (it.projectId == 0L) it.copy(projectId = id) else it }
    }

    fun edit(f: (Draft) -> Draft) = draft.update(f)
    fun setSettings(f: (GenSettings) -> GenSettings) = draft.update { it.copy(settings = f(it.settings)) }
    fun setStyle(f: (TextStyle) -> TextStyle) = draft.update { it.copy(style = f(it.style)) }
    fun dismissRecovered() { recovered.value = false }

    fun newProject() {
        draft.value = Draft(); lastSaved = ""
    }

    fun openProject(id: Long, onDone: () -> Unit) = viewModelScope.launch {
        val p = dao.project(id) ?: return@launch
        runCatching { AppJson.decodeFromString<Draft>(p.draftJson) }.getOrNull()?.let {
            lastSaved = p.draftJson; draft.value = it.copy(projectId = p.id); onDone()
        } ?: say("No se pudo abrir el proyecto (datos dañados).")
    }

    fun deleteProject(id: Long) = viewModelScope.launch {
        dao.deleteProject(id)
        if (draft.value.projectId == id) { draft.value = Draft(); lastSaved = "" }
    }

    // ---------------------------------------------------------------- biblioteca
    fun say(m: String) { toast.tryEmit(m) }

    private fun runImport(title: String, scan: suspend () -> List<Candidate>) {
        if (importJob?.isActive == true) { say("Ya hay una importación en curso."); return }
        importJob = viewModelScope.launch {
            importUi.value = ImportUi(true, 0, 0, "Buscando videos…")
            try {
                val cands = withContext(Dispatchers.IO) { scan() }
                if (cands.isEmpty()) { importUi.value = ImportUi(false, 0, 0, "", "No se encontraron videos en $title."); return@launch }
                val r = svc.importer.import(cands) { d, t, n -> importUi.value = ImportUi(true, d, t, n) }
                val msg = buildString {
                    append("${r.added} agregados")
                    if (r.duplicates > 0) append(" (${r.duplicates} duplicados)")
                    if (r.skipped > 0) append(", ${r.skipped} ya estaban")
                    if (r.failed > 0) append(", ${r.failed} no se pudieron leer")
                    if (r.cancelled) append(" — cancelado")
                }
                importUi.value = ImportUi(false, cands.size, cands.size, "", msg)
            } catch (e: CancellationException) {
                importUi.value = ImportUi(false, 0, 0, "", "Importación cancelada.")
            } catch (e: Exception) {
                importUi.value = ImportUi(false, 0, 0, "", "Error al importar: ${e.message}")
            }
        }
    }

    fun importGallery() = runImport("la galería") { svc.importer.scanMediaStore() }
    fun importTree(uri: Uri) {
        persist(uri)
        runImport("la carpeta") { svc.importer.scanTree(uri) }
    }
    fun importFiles(uris: List<Uri>) {
        uris.forEach { persist(it) }
        runImport("los archivos") { uris.map { svc.importer.describe(it) } }
    }
    fun cancelImport() { importJob?.cancel() }
    fun dismissImport() { if (importUi.value?.running != true) importUi.value = null }

    fun persist(uri: Uri) {
        try { getApplication<Application>().contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) { /* MediaStore no lo necesita */ }
    }

    fun deleteVideo(v: VideoEntity) = viewModelScope.launch(Dispatchers.IO) {
        dao.deleteVideo(v.id); svc.importer.deleteThumb(v.thumb)
    }

    fun verifyLibrary() = viewModelScope.launch {
        busy.value = "Verificando archivos…"
        val n = svc.importer.verify(videos.value)
        busy.value = null
        say(if (n == 0) "Todos los archivos siguen disponibles." else "$n videos cambiaron de estado (conectados/desconectados).")
    }

    // ---------------------------------------------------------------- generación del plan
    private suspend fun usedRanges() = dao.usedSegments().map { Range(it.videoId, it.start, it.duration) }

    private suspend fun usable(): List<VideoEntity> = dao.usableVideos()

    private suspend fun aiScores(list: List<VideoEntity>): Map<Long, Double>? {
        val s = draft.value.settings
        val prov = ai.active()
        if (!s.useAI || prov == null) return null
        val todo = list.filter { it.score == null }.take(10)
        todo.forEachIndexed { i, v ->
            busy.value = "IA valorando videos (${i + 1}/${todo.size})…"
            val frames = withContext(Dispatchers.IO) { frames(v) }
            try { ai.scoreVideo(prov, frames)?.let { dao.setScore(v.id, it) } } catch (e: Exception) { say("IA: ${e.message}"); busy.value = null; return null }
            frames.forEach { it.recycle() }
        }
        return dao.usableVideos().associate { it.id to (it.score ?: 0.5) }
    }

    private fun frames(v: VideoEntity): List<Bitmap> {
        val m = MediaMetadataRetriever()
        return try {
            m.setDataSource(getApplication(), Uri.parse(v.uri))
            listOf(0.15, 0.4, 0.65, 0.88).mapNotNull { m.getFrameAtTime((v.duration * it * 1_000_000).toLong(), MediaMetadataRetriever.OPTION_CLOSEST_SYNC) }
        } catch (_: Exception) { emptyList() } finally { try { m.release() } catch (_: Exception) {} }
    }

    /** Crea una selección nueva con el estado actual. Devuelve false (y avisa) si no se puede. */
    suspend fun generate(newSeed: Boolean = true): Boolean {
        val list = usable()
        if (list.isEmpty()) { say("Importa videos en la biblioteca antes de crear."); return false }
        busy.value = "Eligiendo fragmentos…"
        try {
            val scores = aiScores(list)
            val used = usedRanges()
            val seed = if (newSeed) (System.nanoTime() and 0xFFFFFFFFL) else (draft.value.plan?.seed ?: 1L)
            val plan = makePlan(PlanInput(list.map { PVideo(it.id, it.duration) }, draft.value.settings, used, seed = seed, scores = scores))
            draft.update { it.copy(plan = plan) }
            return true
        } catch (e: Exception) { say("No se pudo crear la selección: ${e.message}"); return false } finally { busy.value = null }
    }

    private fun mutatePlan(f: suspend (Plan, List<PVideo>, List<Range>) -> Plan) = viewModelScope.launch {
        val plan = draft.value.plan ?: return@launch
        val vids = usable().map { PVideo(it.id, it.duration) }
        val new = f(plan, vids, usedRanges())
        draft.update { it.copy(plan = new) }
    }

    fun replaceAt(i: Int) = mutatePlan { p, v, u -> replaceSegment(p, i, v, u, System.nanoTime() and 0xFFFFFFFFL) }
    fun deleteAt(i: Int) = mutatePlan { p, _, _ -> if (p.segments.size <= 1) p else p.copy(segments = p.segments.filterIndexed { k, _ -> k != i }) }
    fun addSegment() = mutatePlan { p, v, u -> addSegment(p, 1.5, v, u, System.nanoTime() and 0xFFFFFFFFL) }
    fun move(i: Int, delta: Int) = mutatePlan { p, _, _ ->
        val j = i + delta
        if (j !in p.segments.indices) p else p.copy(segments = p.segments.toMutableList().also { val t = it[i]; it[i] = it[j]; it[j] = t })
    }
    fun replaceWith(i: Int, videoId: Long) = mutatePlan { p, _, _ ->
        val seg = p.segments[i]
        val v = videoMap.value[videoId] ?: return@mutatePlan p
        val start = ((v.duration - seg.duration - 0.05).coerceAtLeast(0.0) * kotlin.random.Random.nextDouble())
        if (v.duration < seg.duration + 0.1) { say("Ese video es demasiado corto para el fragmento."); p }
        else p.copy(segments = p.segments.toMutableList().also { it[i] = seg.copy(uid = "m" + System.nanoTime(), videoId = videoId, start = Math.floor(start * 100) / 100) })
    }
    fun regenerateAll() = viewModelScope.launch { generate(true) }

    // ---------------------------------------------------------------- exportación (lotes de versiones)
    fun startExport(onStarted: () -> Unit) = viewModelScope.launch {
        val d = draft.value
        val base = d.plan ?: return@launch
        if (ExportManager.state.value.running) { say("Ya hay una exportación en curso."); return@launch }
        busy.value = "Preparando versiones…"
        try {
            val list = usable()
            val used = usedRanges()
            val known = dao.comboKeys().toMutableSet()
            val plans = mutableListOf(base)
            val avoid = base.segments.map { Range(it.videoId, it.start, it.duration) }.toMutableList()
            known.add(comboKey(base.segments))
            val pv = list.map { PVideo(it.id, it.duration) }
            val scores = list.associate { it.id to (it.score ?: 0.5) }.takeIf { d.settings.useAI }
            while (plans.size < d.settings.versions.coerceIn(1, 20)) {
                var p: Plan? = null
                var seed = (System.nanoTime() and 0xFFFFFFFFL)
                repeat(6) { // reintenta con otra semilla hasta lograr una combinación no usada nunca
                    if (p == null) {
                        val cand = makePlan(PlanInput(pv, d.settings, used, avoid, seed, scores))
                        if (comboKey(cand.segments) !in known) p = cand else seed = (seed * 1664525L + 1013904223L) and 0xFFFFFFFFL
                    }
                }
                val chosen = p ?: makePlan(PlanInput(pv, d.settings, used, avoid, seed, scores))
                known.add(comboKey(chosen.segments)); plans.add(chosen)
                avoid.addAll(chosen.segments.map { Range(it.videoId, it.start, it.duration) })
            }
            val byId = dao.videosByIds(plans.flatMap { p -> p.segments.map { it.videoId } }.distinct()).associateBy { it.id }
            val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
            val items = plans.mapIndexed { i, plan ->
                val clips = plan.segments.mapNotNull { s -> byId[s.videoId]?.let { ExportClip(it.uri, (s.start * 1000).toLong(), (s.duration * 1000).toLong()) } }
                ExportItem(ExportSpec("ClipForge_${stamp}_v${i + 1}", clips, d.text, d.style, d.settings), plan.segments)
            }
            if (items.any { it.spec.clips.size != it.segments.size }) { say("Faltan videos de la selección en la biblioteca."); return@launch }
            ExportService.start(getApplication(), ExportBatch(d.projectId, items))
            onStarted()
        } catch (e: Exception) { say("No se pudo iniciar la exportación: ${e.message}") } finally { busy.value = null }
    }

    fun cancelExport() = ExportService.cancel(getApplication())
    fun dismissExport() = ExportManager.dismiss()

    fun deleteOutput(o: OutputEntity) = viewModelScope.launch(Dispatchers.IO) {
        try { getApplication<Application>().contentResolver.delete(Uri.parse(o.uri), null, null) } catch (_: Exception) { /* ya no existía */ }
        dao.deleteOutput(o.id)
    }

    fun clearHistory() = viewModelScope.launch { dao.clearUsed(); say("Historial de fragmentos usados borrado.") }

    // ---------------------------------------------------------------- plantillas de texto
    fun saveTemplate(name: String) = viewModelScope.launch {
        dao.insertTemplate(TemplateEntity(name = name.ifBlank { "Plantilla" }, styleJson = AppJson.encodeToString(draft.value.style)))
        say("Plantilla guardada.")
    }
    fun applyTemplate(t: TemplateEntity) { runCatching { AppJson.decodeFromString<TextStyle>(t.styleJson) }.getOrNull()?.let { s -> setStyle { s } } }
    fun deleteTemplate(id: Long) = viewModelScope.launch { dao.deleteTemplate(id) }

    // ---------------------------------------------------------------- IA
    fun suggest(topic: String, onResult: (List<String>) -> Unit) = viewModelScope.launch {
        val p = ai.active() ?: run { say("Configura un proveedor de IA en «Inteligencia artificial» (es opcional)."); return@launch }
        busy.value = "Pidiendo frases a la IA…"
        try { onResult(ai.suggestPhrases(p, topic)) } catch (e: Exception) { say(e.message ?: "Error de IA") } finally { busy.value = null }
    }

    // ---------------------------------------------------------------- actualizaciones
    val update = MutableStateFlow<UpdateUi>(UpdateUi.Idle)

    fun checkUpdates(silent: Boolean = false) = viewModelScope.launch {
        if (update.value is UpdateUi.Checking || update.value is UpdateUi.Downloading) return@launch
        update.value = UpdateUi.Checking
        update.value = try { Updater.check()?.let { UpdateUi.Available(it) } ?: UpdateUi.None }
        catch (e: Exception) { if (silent) UpdateUi.Idle else UpdateUi.Error(e.message ?: "No se pudo buscar actualizaciones.") }
    }

    fun downloadUpdate() = viewModelScope.launch {
        val r = (update.value as? UpdateUi.Available)?.release ?: return@launch
        update.value = UpdateUi.Downloading(0)
        update.value = try { UpdateUi.Ready(r, Updater.download(getApplication(), r) { p -> update.value = UpdateUi.Downloading(p) }) }
        catch (e: Exception) { UpdateUi.Error(e.message ?: "Falló la descarga.") }
    }

    fun installUpdate() {
        val r = update.value as? UpdateUi.Ready ?: return
        if (!Updater.install(getApplication(), r.file)) say("Permite «Instalar apps desconocidas» para ClipForge y vuelve a pulsar Instalar.")
    }
}
