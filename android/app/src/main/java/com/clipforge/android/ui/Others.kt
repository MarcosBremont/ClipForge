package com.clipforge.android.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.navigation.NavHostController
import com.clipforge.android.BuildConfig
import com.clipforge.android.MainViewModel
import com.clipforge.android.UpdateUi
import com.clipforge.android.ai.PROVIDERS
import com.clipforge.android.model.AppJson
import com.clipforge.android.model.TextStyle
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import java.text.DateFormat
import java.util.Date

@Composable
fun MoreScreen(vm: MainViewModel, nav: NavHostController) {
    val update by vm.update.collectAsState()
    Column(Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Más", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        MoreItem("Videos generados", "Tus exportaciones: reproducir, compartir, borrar") { nav.navigate("generated") }
        MoreItem("Plantillas de texto", "Estilos guardados para reutilizar") { nav.navigate("templates") }
        MoreItem("Inteligencia artificial", "Proveedores opcionales (Gemini, Claude, Grok…)") { nav.navigate("ai") }
        MoreItem("Configuración", if (update is UpdateUi.Available) "¡Hay una actualización disponible!" else "Actualizaciones, historial y permisos") { nav.navigate("settings") }
    }
}

@Composable
private fun MoreItem(title: String, sub: String, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick), shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) { Text(title, fontWeight = FontWeight.Bold); Hint(sub) }
    }
}

@Composable
fun ProjectsScreen(vm: MainViewModel, nav: NavHostController) {
    val projects by vm.projects.collectAsState()
    var confirm by remember { mutableStateOf<Long?>(null) }
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Proyectos", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Button(onClick = { vm.newProject(); nav.navigate("create") }) { Icon(Icons.Filled.Add, null); Spacer(Modifier.width(4.dp)); Text("Nuevo") }
        }
        Hint("Se guardan solos mientras trabajas.")
        if (projects.isEmpty()) Empty("Aún no hay proyectos.")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 10.dp)) {
            items(projects, key = { it.id }) { p ->
                Card(Modifier.fillMaxWidth().clickable { vm.openProject(p.id) { nav.navigate("create") } }, shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Bold)
                            Hint(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(p.updatedAt)))
                        }
                        IconButton(onClick = { confirm = p.id }) { Icon(Icons.Filled.Delete, "Borrar") }
                    }
                }
            }
        }
    }
    confirm?.let { id ->
        AlertDialog(onDismissRequest = { confirm = null }, title = { Text("Borrar proyecto") }, text = { Text("Los videos ya exportados no se borran.") },
            confirmButton = { TextButton(onClick = { vm.deleteProject(id); confirm = null }) { Text("Borrar") } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancelar") } })
    }
}

@Composable
fun GeneratedScreen(vm: MainViewModel) {
    val outputs by vm.outputs.collectAsState()
    val ctx = LocalContext.current
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text("Videos generados", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Hint("Guardados en Movies/ClipForge (también visibles en tu galería).")
        if (outputs.isEmpty()) Empty("Todavía no has exportado ningún video.")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 10.dp)) {
            items(outputs, key = { it.id }) { o ->
                Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(Modifier.padding(14.dp)) {
                        Text(o.name, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Hint("${fmtDur(o.duration)} · ${fmtSize(o.size)} · ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(o.createdAt))}")
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            TextButton(onClick = {
                                runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(o.uri.toUri(), "video/mp4").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }
                                    .onFailure { vm.say("No hay una app para reproducir el video.") }
                            }) { Icon(Icons.Filled.PlayArrow, null); Text("Ver") }
                            TextButton(onClick = {
                                val send = Intent(Intent.ACTION_SEND).setType("video/mp4").putExtra(Intent.EXTRA_STREAM, o.uri.toUri()).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                ctx.startActivity(Intent.createChooser(send, "Compartir video"))
                            }) { Icon(Icons.Filled.Share, null); Text("Compartir") }
                            TextButton(onClick = { vm.deleteOutput(o) }) { Icon(Icons.Filled.Delete, null); Text("Borrar") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TemplatesScreen(vm: MainViewModel, nav: NavHostController) {
    val templates by vm.templates.collectAsState()
    val d by vm.draft.collectAsState()
    var dialog by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Plantillas de texto", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            OutlinedButton(onClick = { dialog = true }) { Text("Guardar actual") }
        }
        Hint("Guarda el estilo que estás editando en Crear y reutilízalo.")
        if (templates.isEmpty()) Empty("No hay plantillas guardadas.")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 10.dp)) {
            items(templates, key = { it.id }) { t ->
                val style = remember(t.styleJson) { runCatching { AppJson.decodeFromString<TextStyle>(t.styleJson) }.getOrDefault(TextStyle()) }
                Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TextPreview("Aa", style.copy(fontSize = style.fontSize * 1.6f, y = 0.5f), "", null, Modifier.width(54.dp))
                        Column(Modifier.weight(1f)) { Text(t.name, fontWeight = FontWeight.Bold); Hint("${style.fontSize.toInt()} px · ${if (style.outline) "contorno" else "sin contorno"}") }
                        TextButton(onClick = { vm.applyTemplate(t); nav.navigate("create") }) { Text("Usar") }
                        IconButton(onClick = { vm.deleteTemplate(t.id) }) { Icon(Icons.Filled.Delete, "Borrar") }
                    }
                }
            }
        }
    }
    if (dialog) {
        var name by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { dialog = false }, title = { Text("Guardar estilo actual") },
            text = { OutlinedTextField(name, { name = it }, singleLine = true, placeholder = { Text("Nombre") }) },
            confirmButton = { TextButton(onClick = { vm.saveTemplate(name); dialog = false }) { Text("Guardar") } },
            dismissButton = { TextButton(onClick = { dialog = false }) { Text("Cancelar") } })
    }
}

@Composable
fun AiScreen(vm: MainViewModel) {
    val ai = vm.ai
    val scope = rememberCoroutineScope()
    var tick by remember { mutableIntStateOf(0) } // fuerza recomposición tras cambios en preferencias
    val active = remember(tick) { ai.active() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Inteligencia artificial", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Hint("Es totalmente opcional: ClipForge edita sin IA. Con IA puedes sugerir frases y priorizar los videos más atractivos. Las claves se guardan cifradas en este teléfono y nunca salen de él, salvo hacia el proveedor que elijas. Para valorar videos solo se envía una hoja de 4 fotogramas, nunca el video.")
        if (!ai.secureStorageAvailable()) Text("Este teléfono no permite guardar claves cifradas; la IA no estará disponible.", color = MaterialTheme.colorScheme.error)
        PROVIDERS.forEach { p ->
            var key by remember { mutableStateOf("") }
            var model by remember(tick) { mutableStateOf(ai.model(p.id)) }
            var msg by remember { mutableStateOf<String?>(null) }
            var testing by remember { mutableStateOf(false) }
            val saved = remember(tick) { ai.hasKey(p.id) }
            Section(p.label) {
                OutlinedTextField(key, { key = it }, Modifier.fillMaxWidth(), singleLine = true, visualTransformation = PasswordVisualTransformation(),
                    label = { Text(if (saved) "Clave guardada (escribe para reemplazar)" else "Clave de API") })
                OutlinedTextField(model, { model = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Modelo") })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = {
                        try { if (key.isNotBlank()) ai.setKey(p.id, key); ai.setModel(p.id, model); key = ""; msg = "Guardado."; tick++ } catch (e: Exception) { msg = e.message }
                    }) { Text("Guardar") }
                    OutlinedButton(enabled = saved && !testing, onClick = {
                        testing = true; msg = "Probando…"
                        scope.launch { msg = try { "Conexión correcta: ${ai.test(p.id)}" } catch (e: Exception) { e.message ?: "Error" }; testing = false }
                    }) { Text("Probar conexión") }
                    if (saved) TextButton(onClick = { ai.setKey(p.id, ""); if (active == p.id) ai.setActive(null); msg = "Clave borrada."; tick++ }) { Text("Borrar clave") }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = active == p.id, enabled = saved, onClick = { ai.setActive(p.id); tick++ })
                    Text("Usar este proveedor", fontSize = 14.sp)
                }
                msg?.let { Hint(it) }
            }
        }
    }
}

@Composable
fun SettingsScreen(vm: MainViewModel) {
    val update by vm.update.collectAsState()
    var confirmClear by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Configuración", fontSize = 24.sp, fontWeight = FontWeight.Bold)

        Section("Actualizaciones") {
            Hint("Versión instalada: ${BuildConfig.VERSION_NAME}")
            when (val u = update) {
                is UpdateUi.Checking -> Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)); Text("Buscando…") }
                is UpdateUi.None -> Text("Ya tienes la última versión.")
                is UpdateUi.Available -> {
                    Text("Nueva versión ${u.release.version} disponible", fontWeight = FontWeight.Bold)
                    if (u.release.notes.isNotBlank()) Hint(u.release.notes.take(300))
                    Button(onClick = { vm.downloadUpdate() }) { Text("Descargar") }
                }
                is UpdateUi.Downloading -> Column { Text("Descargando… ${u.percent} %"); LinearProgressIndicator(progress = { u.percent / 100f }, Modifier.fillMaxWidth().padding(top = 6.dp)) }
                is UpdateUi.Ready -> {
                    Text("Versión ${u.release.version} lista para instalar", fontWeight = FontWeight.Bold)
                    Button(onClick = { vm.installUpdate() }) { Text("Instalar") }
                    Hint("Android te pedirá confirmar. Si es la primera vez, concede el permiso «Instalar apps desconocidas» a ClipForge.")
                }
                is UpdateUi.Error -> Text(u.message, color = MaterialTheme.colorScheme.error)
                UpdateUi.Idle -> {}
            }
            OutlinedButton(onClick = { vm.checkUpdates() }, enabled = update !is UpdateUi.Checking && update !is UpdateUi.Downloading) { Text("Buscar actualizaciones") }
        }

        Section("Carpeta de salida") {
            Text("Movies/ClipForge", fontWeight = FontWeight.Bold)
            Hint("Los videos exportados se guardan en el almacenamiento del teléfono y aparecen en la galería.")
        }

        Section("Biblioteca") {
            OutlinedButton(onClick = { vm.verifyLibrary() }) { Text("Verificar archivos desconectados") }
            Hint("Marca los videos cuyo archivo ya no está accesible (disco externo desconectado, carpeta de nube sin sincronizar…).")
        }

        Section("Registro de combinaciones") {
            Hint("Cada video generado registra qué fragmentos usó para no repetirlos en futuros proyectos. Puedes borrar ese historial.")
            OutlinedButton(onClick = { confirmClear = true }) { Text("Borrar historial de fragmentos usados") }
        }

        Section("Rendimiento") {
            Hint("La exportación usa el codificador de hardware del teléfono cuando existe (más rápido y con menos calor) y pasa a software automáticamente si falla. Para lotes largos conecta el cargador.")
        }
    }
    if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("Borrar historial") },
        text = { Text("Se permitirá volver a usar cualquier fragmento. Los videos exportados no se tocan.") },
        confirmButton = { TextButton(onClick = { vm.clearHistory(); confirmClear = false }) { Text("Borrar") } },
        dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancelar") } })
}
