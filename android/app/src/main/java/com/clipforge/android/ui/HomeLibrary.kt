package com.clipforge.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.navigation.NavHostController
import coil.compose.AsyncImage
import com.clipforge.android.MainViewModel
import com.clipforge.android.data.VideoEntity
import java.io.File
import java.text.DateFormat
import java.util.Date

@Composable
fun HomeScreen(vm: MainViewModel, nav: NavHostController) {
    val stats by vm.stats.collectAsState()
    val projects by vm.projects.collectAsState()
    val outputs by vm.outputs.collectAsState()
    val recovered by vm.recovered.collectAsState()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("ClipForge", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Text("Crea videos verticales virales con tu propia biblioteca.", color = MaterialTheme.colorScheme.onSurfaceVariant)

        if (recovered) Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f))) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Recuperamos tu último proyecto", fontWeight = FontWeight.Bold)
                Text("Se guardó automáticamente. Puedes seguir donde lo dejaste.", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.dismissRecovered(); nav.navigate("create") }) { Text("Continuar") }
                    TextButton(onClick = { vm.dismissRecovered(); vm.newProject() }) { Text("Empezar de cero") }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCard("Videos", stats.count.toString(), Modifier.weight(1f))
            StatCard("Duración", fmtDur(stats.totalDuration), Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCard("Espacio", fmtSize(stats.totalSize), Modifier.weight(1f))
            StatCard("Generados", outputs.size.toString(), Modifier.weight(1f))
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = { nav.navigate("create") }, Modifier.weight(1f)) { Text("Crear video") }
            OutlinedButton(onClick = { nav.navigate("library") }, Modifier.weight(1f)) { Text("Importar videos") }
        }
        if (stats.count == 0) Hint("Empieza importando videos desde la pestaña Biblioteca (galería, carpetas o archivos).")

        if (projects.isNotEmpty()) Section("Proyectos recientes") {
            projects.take(4).forEach { p ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).combinedClickableSimple { vm.openProject(p.id) { nav.navigate("create") } }.padding(vertical = 6.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Hint(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(p.updatedAt)))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableSimple(onClick: () -> Unit): Modifier = this.combinedClickable(onClick = onClick)

@Composable
private fun StatCard(label: String, value: String, modifier: Modifier) {
    Card(modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp)) {
            Text(value, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Hint(label)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LibraryScreen(vm: MainViewModel) {
    val ctx = LocalContext.current
    val videos by vm.videos.collectAsState()
    val stats by vm.stats.collectAsState()
    var query by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var toDelete by remember { mutableStateOf<VideoEntity?>(null) }

    val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_VIDEO else Manifest.permission.READ_EXTERNAL_STORAGE
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) vm.importGallery() else vm.say("Sin permiso para ver la galería. Usa «Carpeta» o «Archivos sueltos», o concede el permiso en Ajustes.")
    }
    val treeLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { it?.let(vm::importTree) }
    val filesLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { if (it.isNotEmpty()) vm.importFiles(it) }
    fun importGallery() {
        if (ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED) vm.importGallery() else permLauncher.launch(perm)
    }

    val shown = remember(videos, query) { if (query.isBlank()) videos else videos.filter { it.name.contains(query, true) || it.folder.contains(query, true) } }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(query, { query = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text("Buscar") }, leadingIcon = { Icon(Icons.Filled.Search, null) })
            Box {
                Button(onClick = { menu = true }) { Icon(Icons.Filled.Add, null); Spacer(Modifier.width(4.dp)); Text("Importar") }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("De la galería") }, onClick = { menu = false; importGallery() })
                    DropdownMenuItem(text = { Text("Carpeta (disco externo, nube…)") }, onClick = { menu = false; treeLauncher.launch(null) })
                    DropdownMenuItem(text = { Text("Archivos sueltos") }, onClick = { menu = false; filesLauncher.launch(arrayOf("video/*")) })
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Hint("${stats.count} videos · ${fmtDur(stats.totalDuration)} · ${fmtSize(stats.totalSize)}" + if (stats.duplicates > 0) " · ${stats.duplicates} duplicados" else "")
            TextButton(onClick = { vm.verifyLibrary() }) { Text("Verificar", fontSize = 12.sp) }
        }
        if (videos.isEmpty()) Empty("Tu biblioteca está vacía.\nImporta videos de la galería, de una carpeta (también discos externos o carpetas sincronizadas) o archivos sueltos.")
        else LazyVerticalGrid(GridCells.Adaptive(110.dp), Modifier.fillMaxSize(), contentPadding = PaddingValues(10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(shown, key = { it.id }) { v ->
                Card(Modifier.combinedClickable(onClick = {}, onLongClick = { toDelete = v }), shape = RoundedCornerShape(10.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Box {
                        AsyncImage(v.thumb?.let { File(it) }, v.name, Modifier.fillMaxWidth().aspectRatio(0.62f), contentScale = ContentScale.Crop)
                        Text(fmtDur(v.duration), Modifier.align(Alignment.BottomEnd).padding(4.dp).background(Color(0xAA000000), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp), fontSize = 11.sp, color = Color.White)
                        Row(Modifier.align(Alignment.TopStart).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            if (v.dupOf != null) Badge("DUP", Color(0xFFE0A030))
                            if (v.missing) Badge("OFF", Color(0xFFE05050))
                        }
                    }
                    Column(Modifier.padding(6.dp)) {
                        Text(v.name, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Hint("${v.width}×${v.height} · ${fmtSize(v.size)}")
                    }
                }
            }
        }
    }
    toDelete?.let { v ->
        AlertDialog(onDismissRequest = { toDelete = null }, title = { Text("Quitar de la biblioteca") },
            text = { Text("«${v.name}» se quitará de ClipForge. El archivo original NO se borra del teléfono.") },
            confirmButton = { TextButton(onClick = { vm.deleteVideo(v); toDelete = null }) { Text("Quitar") } },
            dismissButton = { TextButton(onClick = { toDelete = null }) { Text("Cancelar") } })
    }
}

@Composable
private fun Badge(text: String, color: Color) =
    Text(text, Modifier.background(color, RoundedCornerShape(4.dp)).padding(horizontal = 4.dp), fontSize = 10.sp, color = Color.Black, fontWeight = FontWeight.Bold)
