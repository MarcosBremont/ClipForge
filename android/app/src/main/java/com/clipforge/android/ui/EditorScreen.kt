package com.clipforge.android.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateRotation
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.navigation.NavHostController
import coil.compose.AsyncImage
import com.clipforge.android.editor.*
import com.clipforge.android.text.TextRenderer
import kotlinx.coroutines.delay
import java.io.File
import kotlin.math.abs
import kotlin.math.max

private enum class Dlg { ADD, SPEED, VOLUME, TEXT, MUSIC, PROJECTS, FILTER, FRAME, FADE, TRANS, AUDIO, CAPTIONS }

private val RED = Color(0xFFFF4D6D)

// =====================================================================================================================
// Pantalla
// =====================================================================================================================

@Composable
fun EditorScreen(evm: EditorViewModel, nav: NavHostController) {
    val project by evm.project.collectAsState()
    val sel by evm.sel.collectAsState()
    val playing by evm.playing.collectAsState()
    val playhead by evm.playhead.collectAsState()
    val canUndo by evm.canUndo.collectAsState()
    val canRedo by evm.canRedo.collectAsState()
    val saved by evm.saved.collectAsState()
    val videos by evm.videos.collectAsState()
    var dlg by remember { mutableStateOf<Dlg?>(null) }
    var menu by remember { mutableStateOf(false) }
    val total = totalDuration(project)

    val musicPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) evm.setMusic(uri, uri.lastPathSegment?.substringAfterLast('/') ?: "música")
    }
    val sfxPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) evm.addAudioFile(uri, uri.lastPathSegment?.substringAfterLast('/') ?: "audio", "sfx")
    }
    val voicePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) evm.addAudioFile(uri, uri.lastPathSegment?.substringAfterLast('/') ?: "voz", "voice")
    }
    var transIdx by remember { mutableIntStateOf(-1) }
    DisposableEffect(Unit) { onDispose { evm.setPlaying(false) } }

    Column(Modifier.fillMaxSize()) {
        // ---- barra superior
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.Filled.ArrowBack, "Volver") }
            BasicTextField(
                project.name, { evm.rename(it) }, Modifier.weight(1f), singleLine = true,
                textStyle = androidx.compose.ui.text.TextStyle(color = MaterialTheme.colorScheme.onBackground, fontSize = 16.sp, fontWeight = FontWeight.Bold),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary)
            )
            Text(if (saved) "✔" else "…", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Proyectos") }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("Proyecto nuevo") }, onClick = { menu = false; evm.newProject() })
                    DropdownMenuItem(text = { Text("Mis proyectos del editor") }, onClick = { menu = false; dlg = Dlg.PROJECTS })
                }
            }
            Button(onClick = { evm.export { nav.navigate("generated") } }, enabled = project.clips.isNotEmpty(), contentPadding = PaddingValues(horizontal = 14.dp)) { Text("Exportar") }
        }

        // ---- vista previa
        Box(Modifier.weight(1f).fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) { EditorPreview(evm) }

        // ---- controles
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            FilledIconButton(onClick = { evm.setPlaying(!playing) }, Modifier.size(42.dp), enabled = project.clips.isNotEmpty()) {
                if (playing) Text("⏸", fontSize = 18.sp) else Icon(Icons.Filled.PlayArrow, "Reproducir")
            }
            Text("  ${fmtDur(playhead)} / ${fmtDur(total)}", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { evm.undo() }, enabled = canUndo) { Text("↶", fontSize = 20.sp, color = if (canUndo) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.outline) }
            IconButton(onClick = { evm.redo() }, enabled = canRedo) { Text("↷", fontSize = 20.sp, color = if (canRedo) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.outline) }
            IconButton(onClick = { evm.pps.value = (evm.pps.value / 1.3f).coerceAtLeast(14f) }) { Text("−", fontSize = 22.sp) }
            IconButton(onClick = { evm.pps.value = (evm.pps.value * 1.3f).coerceAtMost(240f) }) { Text("+", fontSize = 22.sp) }
        }

        // ---- línea de tiempo
        TimelinePanel(evm, Modifier.fillMaxWidth().height(232.dp)) { i -> transIdx = i; dlg = Dlg.TRANS }

        // ---- herramientas (cambian según lo seleccionado)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (sel?.kind) {
                SelKind.CLIP -> {
                    Tool("✂ Dividir") { evm.split() }
                    Tool("⏩ Velocidad") { dlg = Dlg.SPEED }
                    Tool("🔊 Volumen") { dlg = Dlg.VOLUME }
                    Tool("🎨 Filtros") { dlg = Dlg.FILTER }
                    Tool("⤢ Encuadre") { dlg = Dlg.FRAME }
                    Tool("◐ Fundidos") { dlg = Dlg.FADE }
                    Tool("⧉ Duplicar") { evm.duplicateSelected() }
                    Tool("🗑 Eliminar") { evm.deleteSelected() }
                }
                SelKind.TEXT -> {
                    Tool("✎ Editar texto") { dlg = Dlg.TEXT }
                    Tool("◎ Centrar") { val id = sel!!.id; evm.apply { setText(it, id, style = { s -> s.copy(x = 0.5f, y = 0.5f) }) } }
                    Tool("⧉ Duplicar") { evm.duplicateSelected() }
                    Tool("🗑 Eliminar") { evm.deleteSelected() }
                }
                SelKind.MUSIC -> {
                    Tool("🔊 Volumen") { dlg = Dlg.MUSIC }
                    Tool("🗑 Quitar") { evm.deleteSelected() }
                }
                SelKind.AUDIO -> {
                    Tool("🎚 Ajustes") { dlg = Dlg.AUDIO }
                    Tool("🗑 Quitar") { evm.deleteSelected() }
                }
                null -> {
                    Tool("＋ Video") { dlg = Dlg.ADD }
                    Tool("T Texto") { evm.addTextHere() }
                    Tool("♪ Música") { musicPicker.launch(arrayOf("audio/*")) }
                    Tool("🔊 Audio") { sfxPicker.launch(arrayOf("audio/*")) }
                    Tool("🎙 Voz") { voicePicker.launch(arrayOf("audio/*")) }
                    Tool("💬 Subtítulos") { dlg = Dlg.CAPTIONS }
                    Tool("✂ Dividir") { evm.split() }
                }
            }
        }
    }

    // ---- diálogos
    when (dlg) {
        Dlg.ADD -> AddVideoDialog(evm) { dlg = null }
        Dlg.SPEED -> sel?.takeIf { it.kind == SelKind.CLIP }?.let { s ->
            val c = project.clips.find { it.id == s.id }
            if (c != null) SpeedDialog(c.speed, { v -> evm.apply { setClip(it, c.id, speed = v) } }) { dlg = null } else dlg = null
        }
        Dlg.VOLUME -> sel?.takeIf { it.kind == SelKind.CLIP }?.let { s ->
            val c = project.clips.find { it.id == s.id }
            if (c != null) SliderDialog("Volumen del clip", c.volume.toFloat(), { v -> evm.edit("vol${c.id}") { setClip(it, c.id, volume = v.toDouble()) } }) { dlg = null } else dlg = null
        }
        Dlg.MUSIC -> project.music?.let { m ->
            SliderDialog("Volumen de la música", m.volume.toFloat(), { v -> evm.edit("mus") { p -> p.copy(music = p.music?.copy(volume = v.toDouble())) } }) { dlg = null }
        } ?: run { dlg = null }
        Dlg.TEXT -> sel?.takeIf { it.kind == SelKind.TEXT }?.let { s ->
            val t = project.texts.find { it.id == s.id }
            if (t != null) TextDialog(evm, t.id) { dlg = null } else dlg = null
        }
        Dlg.PROJECTS -> ProjectsDialog(evm) { dlg = null }
        Dlg.FILTER -> sel?.takeIf { it.kind == SelKind.CLIP }?.let { s -> if (project.clips.any { it.id == s.id }) FilterDialog(evm, s.id) { dlg = null } else dlg = null }
        Dlg.FRAME -> sel?.takeIf { it.kind == SelKind.CLIP }?.let { s -> if (project.clips.any { it.id == s.id }) FrameDialog(evm, s.id) { dlg = null } else dlg = null }
        Dlg.FADE -> sel?.takeIf { it.kind == SelKind.CLIP }?.let { s -> if (project.clips.any { it.id == s.id }) FadeDialog(evm, s.id) { dlg = null } else dlg = null }
        Dlg.TRANS -> TransitionDialog(evm, transIdx) { dlg = null }
        Dlg.CAPTIONS -> CaptionsDialog(evm) { dlg = null }
        Dlg.AUDIO -> sel?.takeIf { it.kind == SelKind.AUDIO }?.let { s -> if (project.audios.any { it.id == s.id }) AudioDialog(evm, s.id) { dlg = null } else dlg = null }
        null -> {}
    }
    @Suppress("UNUSED_EXPRESSION") videos
}

@Composable
private fun Tool(label: String, onClick: () -> Unit) =
    AssistChip(onClick = onClick, label = { Text(label, fontSize = 13.sp) })

// =====================================================================================================================
// Vista previa (ExoPlayer) con textos arrastrables
// =====================================================================================================================

@Composable
private fun EditorPreview(evm: EditorViewModel) {
    val ctx = LocalContext.current
    val project by evm.project.collectAsState()
    val videos by evm.videos.collectAsState()
    val playhead by evm.playhead.collectAsState()
    val playing by evm.playing.collectAsState()
    val seekTick by evm.seekTick.collectAsState()
    val sel by evm.sel.collectAsState()
    val projectNow by rememberUpdatedState(project)
    val player = remember { ExoPlayer.Builder(ctx).build() }
    var guideV by remember { mutableStateOf(false) }
    var guideH by remember { mutableStateOf(false) }
    var curIdx by remember { mutableIntStateOf(0) }
    val extras = remember { HashMap<String, ExoPlayer>() } // pistas de audio extra (efectos, voz)

    DisposableEffect(Unit) { onDispose { player.release(); extras.values.forEach { it.release() }; extras.clear() } }

    fun applyItem() {
        val c = projectNow.clips.getOrNull(player.currentMediaItemIndex) ?: return
        player.playbackParameters = PlaybackParameters(c.speed.toFloat())
        player.volume = c.volume.toFloat().coerceIn(0f, 1f)
    }
    fun seekPlayer(t: Double) {
        val loc = locate(projectNow, t) ?: return
        val c = projectNow.clips[loc.index]
        if (player.mediaItemCount > loc.index) player.seekTo(loc.index, ((loc.src - c.srcStart) * 1000).toLong().coerceAtLeast(0))
        applyItem()
    }

    // Cada clip es un MediaItem recortado: la reproducción encadenada imita el video final.
    val sig = project.clips.joinToString("|") { "${it.id}:${it.srcStart}:${it.srcEnd}" } + "#" + videos.size
    LaunchedEffect(sig) {
        val items = project.clips.mapNotNull { c ->
            videos[c.videoId]?.let { v ->
                MediaItem.Builder().setUri(v.uri.toUri()).setMediaId(c.id)
                    .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setStartPositionMs((c.srcStart * 1000).toLong()).setEndPositionMs((c.srcEnd * 1000).toLong()).build()).build()
            }
        }
        if (items.size != project.clips.size) return@LaunchedEffect // faltan videos en la biblioteca
        val resume = player.playWhenReady
        player.setMediaItems(items); player.prepare()
        if (items.isNotEmpty()) seekPlayer(evm.playhead.value)
        player.playWhenReady = resume && playing
    }
    LaunchedEffect(project.clips) { applyItem() } // velocidad y volumen se aplican sin reconstruir la lista
    LaunchedEffect(seekTick) { seekPlayer(evm.playhead.value); extras.values.forEach { it.pause() } }
    LaunchedEffect(playing) {
        if (playing) {
            if (evm.playhead.value >= totalDuration(projectNow) - 0.05) { evm.playhead.value = 0.0; seekPlayer(0.0) }
            player.play()
        } else player.pause()
    }
    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) { curIdx = player.currentMediaItemIndex; applyItem() }
            override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_ENDED) { evm.setPlaying(false); evm.playhead.value = totalDuration(projectNow) } }
        }
        player.addListener(l)
        onDispose { player.removeListener(l) }
    }
    // El reloj de la línea de tiempo sigue al reproductor (con la velocidad de cada clip).
    LaunchedEffect(player) {
        while (true) {
            if (player.isPlaying) {
                val idx = player.currentMediaItemIndex
                val p = projectNow
                val c = p.clips.getOrNull(idx)
                if (c != null) evm.playhead.value = clipStarts(p)[idx] + (player.currentPosition / 1000.0) / c.speed
            }
            // pistas de audio extra: arrancan/paran con el reloj y siguen sus fundidos
            val p = projectNow
            val t = evm.playhead.value
            val play = evm.playing.value
            extras.keys.filter { id -> p.audios.none { it.id == id } }.forEach { extras.remove(it)?.release() }
            for (a in p.audios) {
                val ap = extras.getOrPut(a.id) { ExoPlayer.Builder(ctx).build().apply { setMediaItem(MediaItem.fromUri(a.uri.toUri())); prepare() } }
                val lt = t - a.start
                val inside = lt >= 0 && lt < a.duration
                val fade = if (inside) minOf(if (a.fadeIn > 0) lt / a.fadeIn else 1.0, if (a.fadeOut > 0) (a.duration - lt) / a.fadeOut else 1.0).coerceIn(0.0, 1.0) else 1.0
                ap.volume = (a.volume * fade).toFloat().coerceIn(0f, 1f)
                if (play && inside && !ap.isPlaying) { ap.seekTo((lt * 1000).toLong()); ap.play() }
                else if ((!play || !inside) && ap.isPlaying) ap.pause()
            }
            // el fundido también baja el volumen del clip
            val loc = locate(p, t)
            if (loc != null && player.isPlaying) {
                val c = p.clips[loc.index]; val l = clipLook(c); val lt = t - loc.start; val d = clipDur(c)
                val g = minOf(if (l.fadeIn > 0) lt / l.fadeIn else 1.0, if (l.fadeOut > 0) (d - lt) / l.fadeOut else 1.0).coerceIn(0.0, 1.0)
                player.volume = (c.volume * g).toFloat().coerceIn(0f, 1f)
            }
            delay(33)
        }
    }

    val visible = remember(project, playhead) { textsAt(project, playhead) }
    val selText = sel?.takeIf { it.kind == SelKind.TEXT }?.let { s -> project.texts.find { it.id == s.id } }

    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // Cabe en el espacio disponible respetando 9:16
        val w = minOf(maxWidth, maxHeight * 9f / 16f)
        Box(Modifier.width(w).aspectRatio(9f / 16f).clip(RoundedCornerShape(10.dp)).background(Color.Black)) {
            val look = locate(project, playhead)?.let { clipLook(project.clips[it.index]) to it }
            // Color de la vista previa: ColorMatrix sobre la TextureView (mismos parámetros que la exportación)
            val paint = remember(look?.first?.let { listOf(it.bright, it.contrast, it.sat, it.warmth) }) {
                look?.first?.takeIf { it.bright != 0.0 || it.contrast != 1.0 || it.sat != 1.0 || it.warmth != 0.0 }?.let { l ->
                    val cm = android.graphics.ColorMatrix().apply { setSaturation(l.sat.toFloat()) }
                    val c = l.contrast.toFloat(); val off = (0.5f - 0.5f * c + l.bright.toFloat()) * 255f
                    val rw = (1 + 0.15 * l.warmth).toFloat(); val bw = (1 - 0.15 * l.warmth).toFloat()
                    cm.postConcat(android.graphics.ColorMatrix(floatArrayOf(c * rw, 0f, 0f, 0f, off, 0f, c, 0f, 0f, off, 0f, 0f, c * bw, 0f, off, 0f, 0f, 0f, 1f, 0f)))
                    android.graphics.Paint().apply { colorFilter = android.graphics.ColorMatrixColorFilter(cm) }
                }
            }
            AndroidView(
                factory = { c ->
                    (android.view.LayoutInflater.from(c).inflate(com.clipforge.android.R.layout.editor_player, null) as PlayerView).apply {
                        this.player = player; setShutterBackgroundColor(android.graphics.Color.TRANSPARENT)
                    }
                },
                update = { pv -> (pv.videoSurfaceView as? android.view.TextureView)?.setLayerPaint(paint) },
                modifier = Modifier.fillMaxSize().graphicsLayer {
                    val l = look?.first ?: return@graphicsLayer
                    val loc = look.second
                    val c = project.clips[loc.index]
                    scaleX = (if (l.flip) -1f else 1f) * l.scale.toFloat(); scaleY = l.scale.toFloat()
                    rotationZ = l.rot.toFloat()
                    translationX = (l.px * size.width).toFloat(); translationY = (l.py * size.height).toFloat()
                    val lt = playhead - loc.start; val d = clipDur(c)
                    alpha = minOf(if (l.fadeIn > 0) lt / l.fadeIn else 1.0, if (l.fadeOut > 0) (d - lt) / l.fadeOut else 1.0).coerceIn(0.0, 1.0).toFloat()
                }
            )
            // Pellizcar/arrastrar sobre la vista previa con un clip seleccionado: zoom, giro y posición (como en CapCut)
            Box(
                Modifier.fillMaxSize().pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        val cid = evm.sel.value?.takeIf { it.kind == SelKind.CLIP }?.id
                        val k = TextRenderer.W / size.width.toFloat()
                        val onText = textsAt(projectNow, evm.playhead.value).any { TextRenderer.measureBox(it.text, it.style).contains(down.position.x * k, down.position.y * k) }
                        if (cid == null || onText) return@awaitEachGesture
                        var began = false
                        do {
                            val ev = awaitPointerEvent()
                            val zoom = ev.calculateZoom(); val rot = ev.calculateRotation(); val pan = ev.calculatePan()
                            if (zoom != 1f || rot != 0f || pan != Offset.Zero) {
                                if (!began) { began = true; evm.beginGesture() }
                                evm.live { p ->
                                    val c = p.clips.find { it.id == cid } ?: return@live p
                                    var r = c.rot + rot; if (r > 180) r -= 360; if (r < -180) r += 360
                                    setClip(p, cid, scale = c.scale * zoom, rot = r, px = c.px + pan.x / size.width, py = c.py + pan.y / size.height)
                                }
                                ev.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        } while (ev.changes.any { it.pressed })
                    }
                }
            )
            Canvas(
                Modifier.fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures { o ->
                            val k = TextRenderer.W / size.width.toFloat()
                            val hit = textsAt(projectNow, evm.playhead.value).asReversed().firstOrNull { TextRenderer.measureBox(it.text, it.style).contains(o.x * k, o.y * k) }
                            evm.select(hit?.let { Sel(SelKind.TEXT, it.id) })
                        }
                    }
                    .pointerInput(Unit) {
                        var id: String? = null; var ox = 0f; var oy = 0f; var acc = Offset.Zero
                        detectDragGestures(
                            onDragStart = { o ->
                                val k = TextRenderer.W / size.width.toFloat()
                                val hit = textsAt(projectNow, evm.playhead.value).asReversed().firstOrNull { TextRenderer.measureBox(it.text, it.style).contains(o.x * k, o.y * k) }
                                id = hit?.id
                                if (hit != null) { evm.select(Sel(SelKind.TEXT, hit.id)); evm.beginGesture(); ox = hit.style.x; oy = hit.style.y; acc = Offset.Zero }
                            },
                            onDrag = { change, d ->
                                val tid = id ?: return@detectDragGestures
                                change.consume(); acc += d
                                var nx = (ox + acc.x / size.width).coerceIn(0f, 1f); var ny = (oy + acc.y / size.height).coerceIn(0f, 1f)
                                guideV = abs(nx - 0.5f) < 0.012f; guideH = abs(ny - 0.5f) < 0.012f // imán al centro
                                if (guideV) nx = 0.5f
                                if (guideH) ny = 0.5f
                                evm.live { setText(it, tid, style = { s -> s.copy(x = nx, y = ny) }) }
                            },
                            onDragEnd = { id = null; guideV = false; guideH = false },
                            onDragCancel = { id = null; guideV = false; guideH = false }
                        )
                    }
            ) {
                val s = size.width / TextRenderer.W
                drawIntoCanvas { c -> for (t in visible) TextRenderer.draw(c.nativeCanvas, t.text, t.style, s) }
                // recuadro del texto seleccionado
                if (selText != null && visible.any { it.id == selText.id }) {
                    val r = TextRenderer.measureBox(selText.text, selText.style)
                    drawRect(Color(0xFF9B82FF), topLeft = Offset(r.left * s, r.top * s), size = androidx.compose.ui.geometry.Size(r.width() * s, r.height() * s), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f))
                }
                if (guideV) drawLine(Color(0xFFFF5DC8), Offset(size.width / 2, 0f), Offset(size.width / 2, size.height), 2f)
                if (guideH) drawLine(Color(0xFFFF5DC8), Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 2f)
            }
            if (project.clips.isEmpty()) Text("Agrega videos para empezar", Modifier.align(Alignment.Center), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
        }
    }
}

// =====================================================================================================================
// Línea de tiempo
// =====================================================================================================================

private val STEPS = listOf(0.5, 1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0, 120.0)

@Composable
private fun TimelinePanel(evm: EditorViewModel, modifier: Modifier, onJoin: (Int) -> Unit) {
    val project by evm.project.collectAsState()
    val pps by evm.pps.collectAsState()
    val playhead by evm.playhead.collectAsState()
    val playing by evm.playing.collectAsState()
    val sel by evm.sel.collectAsState()
    val videos by evm.videos.collectAsState()
    val density = LocalDensity.current
    val pxPerSec = pps * density.density
    val scroll = rememberScrollState()
    var viewportPx by remember { mutableIntStateOf(0) }
    val total = totalDuration(project)
    val starts = clipStarts(project)
    val step = STEPS.firstOrNull { it * pps >= 56 } ?: 120.0
    val lanes = remember(project.texts) {
        val ends = ArrayList<Double>(); val lane = HashMap<String, Int>()
        for (t in project.texts.sortedBy { it.start }) {
            var k = ends.indexOfFirst { it <= t.start + 1e-6 }
            if (k < 0) { k = ends.size; ends.add(0.0) }
            ends[k] = t.start + t.duration; lane[t.id] = k
        }
        lane to max(1, ends.size)
    }
    val audioLanes = remember(project.audios) {
        val ends = ArrayList<Double>(); val lane = HashMap<String, Int>()
        for (a in project.audios.sortedBy { it.start }) {
            var k = ends.indexOfFirst { it <= a.start + 1e-6 }
            if (k < 0) { k = ends.size; ends.add(0.0) }
            ends[k] = a.start + a.duration; lane[a.id] = k
        }
        lane to max(1, ends.size)
    }
    val audioH = (audioLanes.second * 30 + 8).dp
    val textH = (lanes.second * 30 + 8).dp
    val contentW = (total * pps + 240).dp

    // seguir la cabeza de reproducción mientras se reproduce
    LaunchedEffect(playhead, playing) {
        if (!playing) return@LaunchedEffect
        val x = (playhead * pxPerSec).toInt()
        if (x > scroll.value + viewportPx - 80 || x < scroll.value) scroll.scrollTo(max(0, x - 80))
    }

    Row(modifier.background(MaterialTheme.colorScheme.surface)) {
        Column(Modifier.width(40.dp).fillMaxHeight().background(MaterialTheme.colorScheme.surfaceVariant)) {
            Spacer(Modifier.height(24.dp))
            Gutter("T", textH); Gutter("🎞", 64.dp); Gutter("♪", 34.dp); Gutter("🔊", audioH)
        }
        Box(Modifier.weight(1f).fillMaxHeight().onSizeChanged { viewportPx = it.width }.horizontalScroll(scroll)) {
            Box(Modifier.width(contentW).fillMaxHeight()) {
                Column {
                    // regla: tocar o arrastrar mueve la cabeza de reproducción
                    Box(
                        Modifier.fillMaxWidth().height(24.dp).background(MaterialTheme.colorScheme.surfaceVariant)
                            .pointerInput(pxPerSec) { detectTapGestures { o -> evm.setPlaying(false); evm.select(null); evm.seek(o.x / pxPerSec.toDouble()) } }
                            .pointerInput(pxPerSec) { detectDragGestures(onDragStart = { evm.setPlaying(false) }, onDrag = { change, _ -> change.consume(); evm.seek(change.position.x / pxPerSec.toDouble()) }) }
                    ) {
                        var t = 0.0
                        while (t <= total + 60) { Text(fmtDur(t), Modifier.offset(x = (t * pps).dp + 3.dp, y = 4.dp), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant); t += step }
                    }
                    // pista de textos
                    Box(Modifier.fillMaxWidth().height(textH)) {
                        project.texts.forEach { t -> TextBlock(evm, t, lanes.first[t.id] ?: 0, pps, pxPerSec, sel?.kind == SelKind.TEXT && sel?.id == t.id) }
                    }
                    // pista de video
                    Box(Modifier.fillMaxWidth().height(64.dp)) {
                        project.clips.forEachIndexed { i, c -> ClipBlock(evm, c, starts[i], pps, pxPerSec, sel?.kind == SelKind.CLIP && sel?.id == c.id, videos[c.videoId]?.thumb, videos[c.videoId]?.name ?: "video", videos[c.videoId]?.duration ?: c.srcEnd) }
                        // unión entre clips: + / ◆ abre las transiciones
                        project.clips.dropLast(1).forEachIndexed { i, c ->
                            val tr = transitionAt(project, i)
                            Box(
                                Modifier.offset(x = ((starts[i] + clipDur(c)) * pps).dp - 13.dp, y = 19.dp).size(26.dp).clip(RoundedCornerShape(13.dp))
                                    .background(if (tr > 0) MaterialTheme.colorScheme.primary else Color(0xDDFFFFFF))
                                    .clickable { onJoin(i) },
                                contentAlignment = Alignment.Center
                            ) { Text(if (tr > 0) "◆" else "+", fontSize = 14.sp, color = if (tr > 0) Color.White else Color(0xFF111111)) }
                        }
                    }
                    // pista de música
                    Box(Modifier.fillMaxWidth().height(34.dp)) {
                        val m = project.music
                        if (m == null) Text("Sin música", Modifier.padding(8.dp), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else Box(
                            Modifier.offset(y = 4.dp).width(max(30.0, total * pps).dp).height(26.dp).clip(RoundedCornerShape(7.dp)).background(Color(0xFF1F4D43))
                                .border(if (sel?.kind == SelKind.MUSIC) 2.dp else 1.dp, if (sel?.kind == SelKind.MUSIC) Color.White else Color(0xFF2F8F7A), RoundedCornerShape(7.dp))
                                .pointerInput(Unit) { detectTapGestures { evm.select(Sel(SelKind.MUSIC, "music")) } }.padding(horizontal = 8.dp),
                            contentAlignment = Alignment.CenterStart
                        ) { Text("♪ ${m.name}", fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                    // pistas de audio extra
                    Box(Modifier.fillMaxWidth().height(audioH)) {
                        if (project.audios.isEmpty()) Text("Sin audios extra", Modifier.padding(8.dp), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        project.audios.forEach { a -> AudioBlock(evm, a, audioLanes.first[a.id] ?: 0, pps, pxPerSec, sel?.kind == SelKind.AUDIO && sel?.id == a.id) }
                    }
                }
                // cabeza de reproducción
                Box(Modifier.offset(x = (playhead * pps).dp).width(2.dp).fillMaxHeight().background(RED))
            }
        }
    }
}

@Composable
private fun Gutter(label: String, h: androidx.compose.ui.unit.Dp) =
    Box(Modifier.fillMaxWidth().height(h), contentAlignment = Alignment.Center) { Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }

@Composable
private fun ClipBlock(evm: EditorViewModel, c: EClip, start: Double, pps: Float, pxPerSec: Float, on: Boolean, thumb: String?, name: String, assetDur: Double) {
    val w = max(10.0, clipDur(c) * pps).dp
    Box(
        Modifier.offset(x = (start * pps).dp, y = 4.dp).width(w).height(56.dp).clip(RoundedCornerShape(8.dp))
            .border(if (on) 2.dp else 1.dp, if (on) Color.White else Color(0xFF3A3F50), RoundedCornerShape(8.dp))
            .background(Color(0xFF1B1E29))
            .pointerInput(c.id, pxPerSec) {
                detectTapGestures { o ->
                    evm.select(Sel(SelKind.CLIP, c.id)); evm.setPlaying(false)
                    val s = clipStarts(evm.project.value).getOrNull(evm.project.value.clips.indexOfFirst { it.id == c.id }) ?: start
                    evm.seek(s + o.x / pxPerSec)
                }
            }
            // mantener pulsado y arrastrar = cambiar el orden de los clips
            .pointerInput(c.id, pxPerSec) {
                var acc = 0f; var s0 = 0.0
                detectDragGesturesAfterLongPress(
                    onDragStart = {
                        evm.select(Sel(SelKind.CLIP, c.id)); evm.setPlaying(false); evm.beginGesture(); acc = 0f
                        s0 = clipStarts(evm.project.value).getOrNull(evm.project.value.clips.indexOfFirst { it.id == c.id }) ?: start
                    },
                    onDrag = { change, d ->
                        change.consume(); acc += d.x
                        val p = evm.project.value
                        val me = p.clips.indexOfFirst { it.id == c.id }
                        if (me < 0) return@detectDragGesturesAfterLongPress
                        val center = s0 + clipDur(p.clips[me]) / 2 + acc / pxPerSec
                        var accT = 0.0; var target = 0
                        for (o in p.clips) { if (o.id == c.id) continue; val dd = clipDur(o); if (center > accT + dd / 2) target++; accT += dd }
                        if (target != me) evm.live { moveClip(it, me, target) }
                    }
                )
            }
    ) {
        if (thumb != null) AsyncImage(File(thumb), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alpha = 0.55f)
        Column(Modifier.padding(horizontal = 6.dp, vertical = 3.dp)) {
            Text(name, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Color.White)
            Spacer(Modifier.weight(1f))
            Text("${"%.1f".format(clipDur(c))}s" + (if (c.speed != 1.0) " · ${c.speed}×" else "") + (if (c.volume <= 0.001) " · 🔇" else ""), fontSize = 10.sp, color = Color(0xFFDDDDDD), maxLines = 1)
        }
        if (on) {
            Handle(Modifier.align(Alignment.CenterStart)) { // recortar el inicio
                var acc = 0f; var base = 0.0
                Modifier.pointerInput(c.id, pxPerSec) {
                    detectDragGestures(
                        onDragStart = { evm.beginGesture(); acc = 0f; base = evm.project.value.clips.find { it.id == c.id }?.srcStart ?: c.srcStart },
                        onDrag = { change, d -> change.consume(); acc += d.x; val sp = evm.project.value.clips.find { it.id == c.id }?.speed ?: c.speed; evm.live { trimClip(it, c.id, true, base + (acc / pxPerSec) * sp, assetDur) } }
                    )
                }
            }
            Handle(Modifier.align(Alignment.CenterEnd)) { // recortar el final
                var acc = 0f; var base = 0.0
                Modifier.pointerInput(c.id, pxPerSec) {
                    detectDragGestures(
                        onDragStart = { evm.beginGesture(); acc = 0f; base = evm.project.value.clips.find { it.id == c.id }?.srcEnd ?: c.srcEnd },
                        onDrag = { change, d -> change.consume(); acc += d.x; val sp = evm.project.value.clips.find { it.id == c.id }?.speed ?: c.speed; evm.live { trimClip(it, c.id, false, base + (acc / pxPerSec) * sp, assetDur) } }
                    )
                }
            }
        }
    }
}

/** Asa de arrastre en el borde de un bloque (ancha para dedos). */
@Composable
private fun Handle(align: Modifier, gestures: @Composable () -> Modifier) {
    Box(align.width(26.dp).fillMaxHeight().background(Color.White.copy(alpha = 0.85f)).then(gestures()), contentAlignment = Alignment.Center) {
        Box(Modifier.width(3.dp).height(20.dp).background(Color(0xFF555B70), RoundedCornerShape(2.dp)))
    }
}

@Composable
private fun AudioBlock(evm: EditorViewModel, a: EAudio, lane: Int, pps: Float, pxPerSec: Float, on: Boolean) {
    Box(
        Modifier.offset(x = (a.start * pps).dp, y = (4 + lane * 30).dp).width(max(18.0, a.duration * pps).dp).height(26.dp).clip(RoundedCornerShape(7.dp))
            .background(if (on) Color(0xFF7A5418) else Color(0xFF5A3D12))
            .border(if (on) 2.dp else 1.dp, if (on) Color.White else Color(0xFFB8812A), RoundedCornerShape(7.dp))
            .pointerInput(a.id) { detectTapGestures { evm.select(Sel(SelKind.AUDIO, a.id)); evm.setPlaying(false) } }
            .then(
                if (on) Modifier.pointerInput(a.id, pxPerSec) { // mover la pista en el tiempo (con imán)
                    var acc = 0f; var s0 = 0.0
                    detectDragGestures(
                        onDragStart = { evm.beginGesture(); acc = 0f; s0 = (evm.project.value.audios.find { it.id == a.id } ?: a).start },
                        onDrag = { change, d ->
                            change.consume(); acc += d.x
                            val want = s0 + acc / pxPerSec
                            val use = snap(want, snapPoints(evm.project.value, evm.playhead.value), 24.0 / pxPerSec)
                            evm.live { moveAudio(it, a.id, use) }
                        }
                    )
                } else Modifier
            )
    ) {
        Text((if (a.kind == "voice") "🎙 " else if (a.kind == "music") "♪ " else "🔊 ") + a.name, Modifier.padding(start = 8.dp, end = 8.dp).align(Alignment.CenterStart), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (on) Handle(Modifier.align(Alignment.CenterEnd)) { // acortar / alargar el final
            var acc = 0f; var base = 0.0
            Modifier.pointerInput(a.id, pxPerSec) {
                detectDragGestures(
                    onDragStart = { evm.beginGesture(); acc = 0f; val cur = evm.project.value.audios.find { it.id == a.id } ?: a; base = cur.start + cur.duration },
                    onDrag = { change, d ->
                        change.consume(); acc += d.x
                        val cur = evm.project.value.audios.find { it.id == a.id } ?: a
                        evm.live { setAudio(it, a.id, duration = max(MIN_AUDIO, base + acc / pxPerSec - cur.start)) }
                    }
                )
            }
        }
    }
}

@Composable
private fun TextBlock(evm: EditorViewModel, t: EText, lane: Int, pps: Float, pxPerSec: Float, on: Boolean) {
    Box(
        Modifier.offset(x = (t.start * pps).dp, y = (4 + lane * 30).dp).width(max(18.0, t.duration * pps).dp).height(26.dp).clip(RoundedCornerShape(7.dp))
            .background(if (on) Color(0xFF5A45C9) else Color(0xFF3A2F78))
            .border(if (on) 2.dp else 1.dp, if (on) Color.White else Color(0xFF5C4CC0), RoundedCornerShape(7.dp))
            .pointerInput(t.id, pxPerSec) {
                detectTapGestures { o ->
                    evm.select(Sel(SelKind.TEXT, t.id)); evm.setPlaying(false)
                    val cur = evm.project.value.texts.find { it.id == t.id } ?: t
                    evm.seek((cur.start + o.x / pxPerSec).coerceIn(cur.start, cur.start + cur.duration - 0.01))
                }
            }
            .then(
                if (on) Modifier.pointerInput(t.id, pxPerSec) { // mover el texto en el tiempo (con imán a los bordes de clips y textos)
                    var acc = 0f; var s0 = 0.0; var dur = 0.0
                    detectDragGestures(
                        onDragStart = { evm.beginGesture(); acc = 0f; val cur = evm.project.value.texts.find { it.id == t.id } ?: t; s0 = cur.start; dur = cur.duration },
                        onDrag = { change, d ->
                            change.consume(); acc += d.x
                            val p = evm.project.value
                            val pts = snapPoints(p, evm.playhead.value, t.id); val thr = 8.0 / (pxPerSec / 1.0)
                            val want = s0 + acc / pxPerSec
                            val a = snap(want, pts, thr * 3); val b = snap(want + dur, pts, thr * 3) - dur
                            val use = if (a != want) a else if (b != want) b else want
                            evm.live { moveText(it, t.id, use) }
                        }
                    )
                } else Modifier
            )
    ) {
        Text("T  ${t.text.ifBlank { "(vacío)" }}", Modifier.padding(start = 8.dp, end = 8.dp).align(Alignment.CenterStart), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (on) {
            Handle(Modifier.align(Alignment.CenterStart)) {
                var acc = 0f; var base = 0.0
                Modifier.pointerInput(t.id, pxPerSec) {
                    detectDragGestures(
                        onDragStart = { evm.beginGesture(); acc = 0f; base = evm.project.value.texts.find { it.id == t.id }?.start ?: t.start },
                        onDrag = { change, d -> change.consume(); acc += d.x; evm.live { resizeText(it, t.id, true, base + acc / pxPerSec) } }
                    )
                }
            }
            Handle(Modifier.align(Alignment.CenterEnd)) {
                var acc = 0f; var base = 0.0
                Modifier.pointerInput(t.id, pxPerSec) {
                    detectDragGestures(
                        onDragStart = { evm.beginGesture(); acc = 0f; val cur = evm.project.value.texts.find { it.id == t.id } ?: t; base = cur.start + cur.duration },
                        onDrag = { change, d -> change.consume(); acc += d.x; evm.live { resizeText(it, t.id, false, base + acc / pxPerSec) } }
                    )
                }
            }
        }
    }
}

// =====================================================================================================================
// Diálogos
// =====================================================================================================================

@Composable
private fun AddVideoDialog(evm: EditorViewModel, onClose: () -> Unit) {
    val videos by evm.videos.collectAsState()
    var added by remember { mutableIntStateOf(0) }
    val list = remember(videos) { videos.values.filter { !it.missing && it.dupOf == null }.sortedByDescending { it.addedAt } }
    AlertDialog(
        onDismissRequest = onClose, title = { Text(if (added == 0) "Agregar video" else "Agregados: $added") },
        text = {
            if (list.isEmpty()) Text("Importa videos en la pestaña Biblioteca para usarlos aquí.")
            else LazyVerticalGrid(GridCells.Adaptive(96.dp), Modifier.heightIn(max = 420.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(list, key = { it.id }) { v ->
                    Box(Modifier.clip(RoundedCornerShape(8.dp)).clickable { evm.addVideo(v); added++ }) {
                        AsyncImage(v.thumb?.let { File(it) }, v.name, Modifier.fillMaxWidth().aspectRatio(0.62f), contentScale = ContentScale.Crop)
                        Text(fmtDur(v.duration), Modifier.align(Alignment.BottomEnd).padding(3.dp).background(Color(0xAA000000), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp), fontSize = 10.sp, color = Color.White)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SpeedDialog(speed: Double, onPick: (Double) -> Unit, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Velocidad") },
        text = { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { SPEEDS.forEach { s -> FilterChip(selected = speed == s, onClick = { onPick(s) }, label = { Text("${s}×") }) } } },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@Composable
private fun SliderDialog(title: String, value: Float, onChange: (Float) -> Unit, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose, title = { Text(title) },
        text = { LabeledSlider("Volumen", value, 0f..1f, "${(value * 100).toInt()} %") { onChange(it) } },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@Composable
private fun TextDialog(evm: EditorViewModel, id: String, onClose: () -> Unit) {
    val project by evm.project.collectAsState()
    val t = project.texts.find { it.id == id } ?: run { onClose(); return }
    val total = totalDuration(project)
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Editar texto") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(t.text, { v -> evm.edit("txt$id") { setText(it, id, text = v) } }, Modifier.fillMaxWidth(), minLines = 2, maxLines = 4, label = { Text("Texto") })
                LabeledSlider("Aparece en", t.start.toFloat(), 0f..max(0.5f, (total - MIN_TEXT).toFloat()), "${"%.1f".format(t.start)} s") { v -> evm.edit("ts$id") { moveText(it, id, v.toDouble()) } }
                LabeledSlider("Dura", t.duration.toFloat(), MIN_TEXT.toFloat()..max(MIN_TEXT.toFloat() + 0.1f, (total - t.start).toFloat()), "${"%.1f".format(t.duration)} s") { v -> evm.edit("td$id") { resizeText(it, id, false, it.texts.find { x -> x.id == id }!!.start + v.toDouble()) } }
                Hint("Arrastra el texto sobre la vista previa para moverlo; se pega al centro al acercarlo.")
                StyleEditor(t.style) { f -> evm.edit("sty$id") { setText(it, id, style = f) } }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

private val FILTER_NAMES = listOf("none" to "Original", "vivid" to "Vívido", "warm" to "Cálido", "cool" to "Frío", "bw" to "B/N", "vintage" to "Vintage", "dramatic" to "Dramático")

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterDialog(evm: EditorViewModel, id: String, onClose: () -> Unit) {
    val project by evm.project.collectAsState()
    val c = project.clips.find { it.id == id } ?: run { onClose(); return }
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Filtros y color") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FILTER_NAMES.forEach { (k, n) -> FilterChip(selected = (c.filter ?: "none") == k, onClick = { evm.apply { applyFilter(it, id, k) } }, label = { Text(n) }) }
                }
                LabeledSlider("Brillo", c.bright.toFloat(), -0.5f..0.5f, "%+d".format((c.bright * 100).toInt())) { v -> evm.edit("br$id") { setClip(it, id, bright = v.toDouble()) } }
                LabeledSlider("Contraste", c.contrast.toFloat(), 0.5f..1.5f, "${(c.contrast * 100).toInt()} %") { v -> evm.edit("co$id") { setClip(it, id, contrast = v.toDouble()) } }
                LabeledSlider("Saturación", c.sat.toFloat(), 0f..2f, "${(c.sat * 100).toInt()} %") { v -> evm.edit("sa$id") { setClip(it, id, sat = v.toDouble()) } }
                LabeledSlider("Calidez", c.warmth.toFloat(), -1f..1f, "%+d".format((c.warmth * 100).toInt())) { v -> evm.edit("wa$id") { setClip(it, id, warmth = v.toDouble()) } }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@Composable
private fun FrameDialog(evm: EditorViewModel, id: String, onClose: () -> Unit) {
    val project by evm.project.collectAsState()
    val c = project.clips.find { it.id == id } ?: run { onClose(); return }
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Encuadre") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Hint("También puedes pellizcar, girar y arrastrar sobre la vista previa con el clip seleccionado.")
                LabeledSlider("Zoom", c.scale.toFloat(), 0.25f..4f, "%.2f×".format(c.scale)) { v -> evm.edit("sc$id") { setClip(it, id, scale = v.toDouble()) } }
                LabeledSlider("Giro", c.rot.toFloat(), -180f..180f, "${c.rot.toInt()}°") { v -> evm.edit("ro$id") { setClip(it, id, rot = v.toDouble()) } }
                LabeledSlider("Posición horizontal", c.px.toFloat(), -1f..1f, "${(c.px * 100).toInt()} %") { v -> evm.edit("px$id") { setClip(it, id, px = v.toDouble()) } }
                LabeledSlider("Posición vertical", c.py.toFloat(), -1f..1f, "${(c.py * 100).toInt()} %") { v -> evm.edit("py$id") { setClip(it, id, py = v.toDouble()) } }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = c.flip, onClick = { evm.apply { setClip(it, id, flip = !c.flip) } }, label = { Text("⇋ Espejo") })
                    AssistChip(onClick = { evm.apply { setClip(it, id, scale = 1.0, rot = 0.0, flip = false, px = 0.0, py = 0.0) } }, label = { Text("Restablecer") })
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@Composable
private fun FadeDialog(evm: EditorViewModel, id: String, onClose: () -> Unit) {
    val project by evm.project.collectAsState()
    val c = project.clips.find { it.id == id } ?: run { onClose(); return }
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Fundidos") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                LabeledSlider("Entrada (desde negro)", c.fadeIn.toFloat(), 0f..3f, "%.1f s".format(c.fadeIn)) { v -> evm.edit("fi$id") { setClip(it, id, fadeIn = v.toDouble()) } }
                LabeledSlider("Salida (hacia negro)", c.fadeOut.toFloat(), 0f..3f, "%.1f s".format(c.fadeOut)) { v -> evm.edit("fo$id") { setClip(it, id, fadeOut = v.toDouble()) } }
                Hint("Afectan a la imagen y al sonido del clip. Nunca pasan de la mitad de su duración.")
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TransitionDialog(evm: EditorViewModel, index: Int, onClose: () -> Unit) {
    val project by evm.project.collectAsState()
    val cur = transitionAt(project, index)
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Transición") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(0.0, 0.3, 0.6, 1.0).forEach { d -> FilterChip(selected = abs(cur - d) < 0.01, onClick = { evm.apply { setTransition(it, index, d) } }, label = { Text(if (d == 0.0) "Ninguna" else "Fundido $d s") }) }
                }
                Hint("Fundido a negro entre los dos clips: el primero se oscurece al final y el siguiente aparece desde negro.")
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@Composable
private fun AudioDialog(evm: EditorViewModel, id: String, onClose: () -> Unit) {
    val project by evm.project.collectAsState()
    val a = project.audios.find { it.id == id } ?: run { onClose(); return }
    val total = totalDuration(project)
    AlertDialog(
        onDismissRequest = onClose, title = { Text(if (a.kind == "voice") "Voz" else "Audio") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Hint(a.name)
                LabeledSlider("Empieza en", a.start.toFloat(), 0f..max(0.5f, (total - a.duration).toFloat()), "%.1f s".format(a.start)) { v -> evm.edit("as$id") { moveAudio(it, id, v.toDouble()) } }
                LabeledSlider("Dura", a.duration.toFloat(), MIN_AUDIO.toFloat()..max(MIN_AUDIO.toFloat() + 0.1f, (total - a.start).toFloat()), "%.1f s".format(a.duration)) { v -> evm.edit("ad$id") { setAudio(it, id, duration = v.toDouble()) } }
                LabeledSlider("Volumen", a.volume.toFloat(), 0f..1f, "${(a.volume * 100).toInt()} %") { v -> evm.edit("av$id") { setAudio(it, id, volume = v.toDouble()) } }
                LabeledSlider("Fundido de entrada", a.fadeIn.toFloat(), 0f..3f, "%.1f s".format(a.fadeIn)) { v -> evm.edit("afi$id") { setAudio(it, id, fadeIn = v.toDouble()) } }
                LabeledSlider("Fundido de salida", a.fadeOut.toFloat(), 0f..3f, "%.1f s".format(a.fadeOut)) { v -> evm.edit("afo$id") { setAudio(it, id, fadeOut = v.toDouble()) } }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Listo") } }
    )
}

@Composable
private fun CaptionsDialog(evm: EditorViewModel, onClose: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var words by remember { mutableFloatStateOf(4f) }
    var fromHere by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Subtítulos") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Hint("Pega o escribe lo que dice el video. Se parte en frases cortas y se reparte por la línea de tiempo según su longitud; después puedes mover o editar cada una.")
                OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), minLines = 4, maxLines = 8, label = { Text("Guion") })
                LabeledSlider("Palabras por subtítulo", words, 1f..8f, "${words.toInt()}") { words = it }
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(fromHere, { fromHere = it }); Text("Empezar en la cabeza de reproducción", fontSize = 13.sp) }
            }
        },
        confirmButton = { TextButton(onClick = { evm.addCaptions(text, words.toInt(), fromHere); onClose() }, enabled = text.isNotBlank()) { Text("Crear subtítulos") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancelar") } }
    )
}

@Composable
private fun ProjectsDialog(evm: EditorViewModel, onClose: () -> Unit) {
    val projects by evm.projects.collectAsState()
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Proyectos del editor") },
        text = {
            if (projects.isEmpty()) Text("Aún no hay proyectos guardados.")
            else Column(Modifier.verticalScroll(rememberScrollState()).heightIn(max = 400.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                projects.forEach { p ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).clickable { evm.open(p.id); onClose() }) {
                            Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Bold)
                            Hint(java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(p.updatedAt)))
                        }
                        IconButton(onClick = { evm.delete(p.id) }) { Icon(Icons.Filled.Delete, "Borrar") }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Cerrar") } }
    )
}
