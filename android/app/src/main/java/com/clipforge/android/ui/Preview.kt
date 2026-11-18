package com.clipforge.android.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.navigation.NavHostController
import coil.compose.AsyncImage
import com.clipforge.android.MainViewModel
import com.clipforge.android.planner.totalDuration
import com.clipforge.android.text.TextRenderer
import kotlinx.coroutines.delay
import java.io.File

@Composable
fun PreviewScreen(vm: MainViewModel, nav: NavHostController, onOpenEditor: () -> Unit) {
    val d by vm.draft.collectAsState()
    val vmap by vm.videoMap.collectAsState()
    val videos by vm.videos.collectAsState()
    val export by vm.export.collectAsState()
    val plan = d.plan
    val ctx = LocalContext.current

    if (plan == null || plan.segments.isEmpty()) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Todavía no hay una selección.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(12.dp))
            Button(onClick = { nav.popBackStack() }) { Text("Volver a Crear") }
        }
        return
    }

    val player = remember { ExoPlayer.Builder(ctx).build().apply { repeatMode = Player.REPEAT_MODE_ALL } }
    DisposableEffect(Unit) { onDispose { player.release() } }

    // Cada fragmento es un MediaItem recortado: la reproducción encadenada imita el video final.
    val key = plan.segments.joinToString("|") { it.uid }
    LaunchedEffect(key, vmap.size) {
        val items = plan.segments.mapNotNull { s ->
            vmap[s.videoId]?.let { v ->
                MediaItem.Builder().setUri(v.uri.toUri()).setMediaId(s.uid)
                    .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setStartPositionMs((s.start * 1000).toLong()).setEndPositionMs(((s.start + s.duration) * 1000).toLong()).build()).build()
            }
        }
        val wasPlaying = player.isPlaying
        player.setMediaItems(items); player.prepare(); player.playWhenReady = wasPlaying
    }

    val total = totalDuration(plan.segments)
    var posMs by remember { mutableLongStateOf(0L) }
    var playing by remember { mutableStateOf(false) }
    var dragging by remember { mutableStateOf(false) }
    var picker by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(player, key) {
        while (true) {
            if (!dragging) {
                val idx = player.currentMediaItemIndex.coerceIn(0, plan.segments.lastIndex)
                posMs = (plan.segments.take(idx).sumOf { it.duration } * 1000).toLong() + player.currentPosition.coerceAtLeast(0)
            }
            playing = player.isPlaying
            delay(80)
        }
    }
    fun seekGlobal(ms: Long) {
        var acc = 0L
        plan.segments.forEachIndexed { i, s ->
            val len = (s.duration * 1000).toLong()
            if (ms < acc + len || i == plan.segments.lastIndex) { player.seekTo(i, (ms - acc).coerceIn(0, len)); return }
            acc += len
        }
    }
    val currentIdx = run {
        var acc = 0.0; var idx = plan.segments.lastIndex
        for ((i, s) in plan.segments.withIndex()) { acc += s.duration; if (posMs / 1000.0 < acc) { idx = i; break } }
        idx
    }

    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        vm.startExport { nav.navigate("generated") } // se exporta aunque se rechace el permiso (solo se pierde la notificación)
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.Filled.ArrowBack, "Volver") }
            Text("Previsualización", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }

        // Reproductor 9:16 con el texto superpuesto (mismo dibujado que la exportación).
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Box(Modifier.fillMaxWidth(0.6f).aspectRatio(9f / 16f).clip(RoundedCornerShape(12.dp))) {
                AndroidView(factory = { c ->
                    PlayerView(c).apply { useController = false; resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM; this.player = player; setShutterBackgroundColor(0) }
                }, modifier = Modifier.fillMaxSize())
                Canvas(Modifier.fillMaxSize()) {
                    drawIntoCanvas {
                        val sc = size.width / TextRenderer.W
                        TextRenderer.draw(it.nativeCanvas, d.text, d.style, sc)
                        TextRenderer.drawWatermark(it.nativeCanvas, d.settings.watermark, sc)
                    }
                }
            }
        }

        Slider(value = if (total > 0) (posMs / 1000f / total.toFloat()).coerceIn(0f, 1f) else 0f,
            onValueChange = { dragging = true; posMs = (it * total * 1000).toLong() },
            onValueChangeFinished = { seekGlobal(posMs); dragging = false })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Hint("${fmtDur(posMs / 1000.0)} / ${fmtDur(total)}"); Hint("Fragmento ${currentIdx + 1} de ${plan.segments.size}")
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { player.seekToPreviousMediaItem() }) { Text("⏮") }
            OutlinedButton(onClick = { seekGlobal((posMs - 1000).coerceAtLeast(0)) }) { Text("−1 s") }
            FilledIconButton(onClick = { if (playing) player.pause() else player.play() }, Modifier.size(52.dp)) {
                if (playing) Text("⏸", fontSize = 20.sp) else Icon(Icons.Filled.PlayArrow, "Reproducir")
            }
            OutlinedButton(onClick = { seekGlobal((posMs + 1000).coerceAtMost((total * 1000).toLong())) }) { Text("+1 s") }
            OutlinedButton(onClick = { player.seekToNextMediaItem() }) { Text("⏭") }
        }

        Text("Fragmentos", fontWeight = FontWeight.Bold, fontSize = 16.sp)
        plan.segments.forEachIndexed { i, s ->
            val v = vmap[s.videoId]
            Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = if (i == currentIdx) MaterialTheme.colorScheme.primary.copy(alpha = 0.22f) else MaterialTheme.colorScheme.surface)) {
                Column(Modifier.clickable { player.seekTo(i, 0) }.padding(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AsyncImage(v?.thumb?.let { File(it) }, null, Modifier.size(width = 36.dp, height = 52.dp).clip(RoundedCornerShape(6.dp)), contentScale = ContentScale.Crop)
                        Column(Modifier.weight(1f)) {
                            Text("${i + 1}. ${v?.name ?: "(video no disponible)"}", maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                            Hint("desde ${fmtDur(s.start)} · ${"%.1f".format(s.duration)} s")
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                        IconButton(onClick = { vm.move(i, -1) }, enabled = i > 0) { Icon(Icons.Filled.KeyboardArrowUp, "Subir") }
                        IconButton(onClick = { vm.move(i, 1) }, enabled = i < plan.segments.lastIndex) { Icon(Icons.Filled.KeyboardArrowDown, "Bajar") }
                        IconButton(onClick = { vm.replaceAt(i) }) { Icon(Icons.Filled.Refresh, "Cambiar por otro al azar") }
                        IconButton(onClick = { picker = i }) { Icon(Icons.Filled.List, "Elegir de la biblioteca") }
                        IconButton(onClick = { vm.deleteAt(i) }, enabled = plan.segments.size > 1) { Icon(Icons.Filled.Delete, "Eliminar") }
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { vm.addSegment() }, Modifier.weight(1f)) { Icon(Icons.Filled.Add, null); Spacer(Modifier.width(4.dp)); Text("Agregar") }
            OutlinedButton(onClick = { vm.regenerateAll() }, Modifier.weight(1f)) { Icon(Icons.Filled.Refresh, null); Spacer(Modifier.width(4.dp)); Text("Regenerar todo") }
        }
        Hint("Duración total ${"%.1f".format(total)} s. Al agregar o eliminar fragmentos la duración cambia.")

        Button(
            onClick = {
                if (Build.VERSION.SDK_INT >= 33) notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
                else vm.startExport { nav.navigate("generated") }
            },
            Modifier.fillMaxWidth().height(54.dp), enabled = !export.running
        ) { Text(if (d.settings.versions > 1) "Exportar ${d.settings.versions} versiones" else "Exportar video", fontSize = 16.sp) }
        OutlinedButton(onClick = onOpenEditor, Modifier.fillMaxWidth()) { Text("✂ Abrir en el editor de video") }
        Hint("Ajusta a mano: recortar, cortar, mover el texto, velocidad, música…")
        Spacer(Modifier.height(20.dp))
    }

    picker?.let { idx ->
        AlertDialog(onDismissRequest = { picker = null }, title = { Text("Elegir video para el fragmento ${idx + 1}") },
            text = {
                LazyVerticalGrid(GridCells.Adaptive(90.dp), Modifier.heightIn(max = 420.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(videos.filter { !it.missing && it.dupOf == null }, key = { it.id }) { v ->
                        AsyncImage(v.thumb?.let { File(it) }, v.name, Modifier.aspectRatio(0.62f).clip(RoundedCornerShape(8.dp)).clickable { vm.replaceWith(idx, v.id); picker = null }, contentScale = ContentScale.Crop)
                    }
                }
            },
            confirmButton = {}, dismissButton = { TextButton(onClick = { picker = null }) { Text("Cancelar") } })
    }
}
