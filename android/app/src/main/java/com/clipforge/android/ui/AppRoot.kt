package com.clipforge.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.clipforge.android.MainViewModel
import com.clipforge.android.UpdateUi
import com.clipforge.android.editor.EditorViewModel

private data class Tab(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val TABS = listOf(
    Tab("home", "Inicio", Icons.Filled.Home),
    Tab("library", "Biblioteca", Icons.Filled.List),
    Tab("create", "Crear", Icons.Filled.Add),
    Tab("editor", "Editor", Icons.Filled.Create),
    Tab("more", "Más", Icons.Filled.MoreVert)
)
private val MORE_ROUTES = setOf("more", "projects", "generated", "templates", "ai", "settings")

@Composable
fun AppRoot() {
    val vm: MainViewModel = viewModel()
    val evm: EditorViewModel = viewModel()
    val nav = rememberNavController()
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.toast.collect { snack.showSnackbar(it) } }
    LaunchedEffect(Unit) { evm.toast.collect { snack.showSnackbar(it) } }
    LaunchedEffect(Unit) { vm.checkUpdates(silent = true) }

    val route = nav.currentBackStackEntryAsState().value?.destination?.route
    val update by vm.update.collectAsState()
    val showBar = route != null && route != "preview" && route != "editor"

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        bottomBar = {
            if (showBar) NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                TABS.forEach { t ->
                    val selected = route == t.route || (t.route == "more" && route in MORE_ROUTES)
                    NavigationBarItem(
                        selected = selected,
                        onClick = { nav.navigate(t.route) { popUpTo(nav.graph.findStartDestination().id) { saveState = false }; launchSingleTop = true } },
                        icon = {
                            if (t.route == "more" && update is UpdateUi.Available) BadgedBox(badge = { Badge() }) { Icon(t.icon, t.label) }
                            else Icon(t.icon, t.label)
                        },
                        label = { Text(t.label, fontSize = 11.sp) }
                    )
                }
            }
        }
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            JobBar(vm, nav)
            NavHost(nav, startDestination = "home", modifier = Modifier.weight(1f)) {
                composable("home") { HomeScreen(vm, nav) }
                composable("library") { LibraryScreen(vm) }
                composable("create") { CreateScreen(vm, nav) }
                composable("preview") { PreviewScreen(vm, nav) { evm.importDraft(vm.draft.value); nav.navigate("editor") } }
                composable("editor") { EditorScreen(evm, nav) }
                composable("projects") { ProjectsScreen(vm, nav) }
                composable("more") { MoreScreen(vm, nav) }
                composable("generated") { GeneratedScreen(vm) }
                composable("templates") { TemplatesScreen(vm, nav) }
                composable("ai") { AiScreen(vm) }
                composable("settings") { SettingsScreen(vm) }
            }
        }
    }
}

/** Barra de tareas en segundo plano: importación y exportación con progreso y cancelación. */
@Composable
private fun JobBar(vm: MainViewModel, nav: NavHostController) {
    val imp by vm.importUi.collectAsState()
    val exp by vm.export.collectAsState()
    val busy by vm.busy.collectAsState()
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        busy?.let { JobCard("Trabajando", it, null, null) }
        imp?.let { i ->
            if (i.running) JobCard("Importando videos", if (i.total > 0) "${i.done} de ${i.total} · ${i.current}" else i.current,
                if (i.total > 0) i.done / i.total.toFloat() else null, "Cancelar") { vm.cancelImport() }
            else i.message?.let { JobCard("Importación", it, null, "Cerrar") { vm.dismissImport() } }
        }
        if (exp.running) JobCard("Exportando ${exp.index} de ${exp.total}", exp.currentName, exp.progress, "Cancelar") { vm.cancelExport() }
        else if (exp.error != null) JobCard("Error al exportar", exp.error ?: "", null, "Cerrar", error = true) { vm.dismissExport() }
        else if (exp.cancelled) JobCard("Exportación cancelada", "", null, "Cerrar") { vm.dismissExport() }
        else if (exp.finished.isNotEmpty()) JobCard("Exportación completada", "${exp.finished.size} video(s) en Movies/ClipForge", null, "Ver") { vm.dismissExport(); nav.navigate("generated") }
    }
}

@Composable
private fun JobCard(title: String, text: String, progress: Float?, action: String?, error: Boolean = false, onAction: (() -> Unit)? = null) {
    Card(
        Modifier.fillMaxWidth().padding(top = 6.dp), shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = if (error) MaterialTheme.colorScheme.error.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    if (text.isNotBlank()) Text(text, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                }
                if (action != null && onAction != null) TextButton(onClick = onAction) { Text(action) }
            }
            if (progress != null) LinearProgressIndicator(progress = { progress.coerceIn(0f, 1f) }, Modifier.fillMaxWidth().padding(top = 8.dp))
            else if (action == null) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
        }
    }
}
