package com.clipforge.android.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import coil.compose.AsyncImage
import com.clipforge.android.MainViewModel
import com.clipforge.android.model.FONT_CHOICES
import com.clipforge.android.model.TextStyle
import com.clipforge.android.text.TextRenderer
import kotlinx.coroutines.launch
import java.io.File

/** Vista previa en vivo del texto: usa EXACTAMENTE el mismo dibujado que la exportación. */
@Composable
fun TextPreview(text: String, style: TextStyle, watermark: String, backgroundThumb: String?, modifier: Modifier = Modifier) {
    Box(modifier.aspectRatio(9f / 16f).clip(RoundedCornerShape(12.dp)).background(Brush.verticalGradient(listOf(Color(0xFF2A2250), Color(0xFF0E1A2B))))) {
        if (backgroundThumb != null) AsyncImage(File(backgroundThumb), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        Canvas(Modifier.fillMaxSize()) {
            drawIntoCanvas {
                val s = size.width / TextRenderer.W
                TextRenderer.draw(it.nativeCanvas, text.ifBlank { "Tu texto aquí" }, style, s)
                TextRenderer.drawWatermark(it.nativeCanvas, watermark, s)
            }
        }
    }
}

private val COLORS = listOf("#FFFFFF", "#FFE14D", "#5EEAD4", "#FF8FD0", "#FF5A5A", "#000000")

@Composable
fun StyleEditor(style: TextStyle, onChange: ((TextStyle) -> TextStyle) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Hint("Tipografía")
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FONT_CHOICES.forEach { (id, label) -> FilterChip(selected = style.fontFamily == id, onClick = { onChange { it.copy(fontFamily = id) } }, label = { Text(label) }) }
        }
        LabeledSlider("Tamaño", style.fontSize, 36f..150f, "${style.fontSize.toInt()}") { v -> onChange { it.copy(fontSize = v) } }
        SwitchRow("Negrita", style.fontWeight >= 600) { b -> onChange { it.copy(fontWeight = if (b) 700 else 400) } }
        Hint("Color")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            COLORS.forEach { c ->
                val col = Color(android.graphics.Color.parseColor(c))
                Box(Modifier.size(34.dp).clip(CircleShape).background(col)
                    .border(if (style.color.equals(c, true)) 3.dp else 1.dp, if (style.color.equals(c, true)) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, CircleShape)
                    .clickable { onChange { it.copy(color = c) } })
            }
        }
        Hint("Alineación")
        ChipRow(listOf("left" to "Izquierda", "center" to "Centro", "right" to "Derecha"), style.align) { a -> onChange { it.copy(align = a) } }
        LabeledSlider("Posición vertical", style.y, 0.08f..0.92f, "${(style.y * 100).toInt()} %") { v -> onChange { it.copy(y = v) } }
        LabeledSlider("Ancho del bloque", style.maxWidth, 0.4f..0.96f, "${(style.maxWidth * 100).toInt()} %") { v -> onChange { it.copy(maxWidth = v) } }
        SwitchRow("Contorno", style.outline) { b -> onChange { it.copy(outline = b) } }
        if (style.outline) LabeledSlider("Grosor del contorno", style.outlineWidth, 1f..16f, "${style.outlineWidth.toInt()}") { v -> onChange { it.copy(outlineWidth = v) } }
        SwitchRow("Sombra", style.shadow) { b -> onChange { it.copy(shadow = b) } }
        if (style.shadow) LabeledSlider("Difuminado de la sombra", style.shadowBlur, 0f..30f, "${style.shadowBlur.toInt()}") { v -> onChange { it.copy(shadowBlur = v) } }
        SwitchRow("MAYÚSCULAS", style.uppercase) { b -> onChange { it.copy(uppercase = b) } }
    }
}


@Composable
fun CreateScreen(vm: MainViewModel, nav: NavHostController) {
    val d by vm.draft.collectAsState()
    val s = d.settings
    val videos by vm.videos.collectAsState()
    val scope = rememberCoroutineScope()
    var suggestions by remember { mutableStateOf<List<String>>(emptyList()) }
    var templateDialog by remember { mutableStateOf(false) }
    val aiActive = remember(d) { vm.ai.active() != null }

    val musicPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            vm.persist(uri)
            val name = uri.lastPathSegment?.substringAfterLast('/') ?: "música"
            vm.setSettings { it.copy(musicUri = uri.toString(), musicName = name) }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Crear video", fontSize = 24.sp, fontWeight = FontWeight.Bold)

        Section("Texto del video") {
            OutlinedTextField(d.text, { t -> vm.edit { it.copy(text = t) } }, Modifier.fillMaxWidth(), minLines = 2, maxLines = 5,
                placeholder = { Text("Escribe una frase o pregunta…") })
            Hint("El mismo texto aparece centrado en todos los fragmentos.")
            OutlinedButton(onClick = { vm.suggest(d.text) { suggestions = it } }) { Text("Sugerir frases con IA") }
            suggestions.forEach { sug ->
                Text(sug, Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { vm.edit { it.copy(text = sug) }; suggestions = emptyList() }.padding(10.dp), fontSize = 14.sp)
            }
        }

        Section("Duración y cortes") {
            LabeledSlider("Duración total", s.duration.toFloat(), 10f..60f, "${s.duration} s", steps = 49) { v -> vm.setSettings { it.copy(duration = v.toInt()) } }
            SwitchRow("Modo automático", s.auto) { b -> vm.setSettings { it.copy(auto = b) } }
            if (s.auto) Hint("La app decide cuántos fragmentos y de qué duración según el tiempo total.")
            else {
                LabeledSlider("Número de fragmentos", (s.segmentCount ?: 10).toFloat(), 2f..40f, "${s.segmentCount ?: 10}", steps = 37) { v -> vm.setSettings { it.copy(segmentCount = v.toInt()) } }
                Hint("Velocidad de cortes")
                ChipRow(listOf("lento" to "Lenta", "normal" to "Normal", "rapido" to "Rápida"), s.speed) { v -> vm.setSettings { it.copy(speed = v, segmentCount = null, segmentLength = null) } }
            }
        }

        Section("Salida") {
            Hint("Fotogramas por segundo")
            ChipRow(listOf(30 to "30 fps", 60 to "60 fps (nativo)"), s.fps) { v -> vm.setSettings { it.copy(fps = v) } }
            Hint("Calidad")
            ChipRow(listOf("alta" to "Alta", "media" to "Media", "rapida" to "Rápida"), s.quality) { v -> vm.setSettings { it.copy(quality = v) } }
            LabeledSlider("Versiones distintas", s.versions.toFloat(), 1f..10f, "${s.versions}", steps = 8) { v -> vm.setSettings { it.copy(versions = v.toInt()) } }
        }

        Section("Audio") {
            SwitchRow("Conservar audio original", s.originalAudio) { b -> vm.setSettings { it.copy(originalAudio = b) } }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { musicPicker.launch(arrayOf("audio/*")) }) { Text(if (s.musicUri == null) "Elegir música" else "Cambiar música") }
                if (s.musicUri != null) {
                    Text(s.musicName ?: "música", Modifier.weight(1f), maxLines = 1, fontSize = 13.sp)
                    TextButton(onClick = { vm.setSettings { it.copy(musicUri = null, musicName = null) } }) { Text("Quitar") }
                }
            }
            if (s.musicUri != null) LabeledSlider("Volumen de la música", s.musicVolume, 0f..1f, "${(s.musicVolume * 100).toInt()} %") { v -> vm.setSettings { it.copy(musicVolume = v) } }
        }

        Section("Marca de agua propia (opcional)") {
            OutlinedTextField(s.watermark, { w -> vm.setSettings { it.copy(watermark = w) } }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("@tu_usuario") })
            Hint("Solo se dibuja el texto que escribas aquí. ClipForge no añade marcas de otras plataformas.")
        }

        Section("Inteligencia artificial (opcional)") {
            SwitchRow("Priorizar los videos más atractivos con IA", s.useAI && aiActive, enabled = aiActive) { b -> vm.setSettings { it.copy(useAI = b) } }
            if (!aiActive) Hint("Configura un proveedor en Más → Inteligencia artificial. Todo funciona igual sin IA.")
        }

        Section("Estilo del texto") {
            val thumb = d.plan?.segments?.firstOrNull()?.let { seg -> videos.firstOrNull { it.id == seg.videoId }?.thumb } ?: videos.firstOrNull()?.thumb
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                TextPreview(d.text, d.style, s.watermark, thumb, Modifier.fillMaxWidth(0.55f))
            }
            StyleEditor(d.style) { f -> vm.setStyle { f(it) } }
            OutlinedButton(onClick = { templateDialog = true }) { Text("Guardar como plantilla") }
        }

        Button(
            onClick = { scope.launch { if (vm.generate()) nav.navigate("preview") } },
            Modifier.fillMaxWidth().height(54.dp), enabled = d.text.isNotBlank()
        ) { Text(if (d.plan == null) "Generar selección y previsualizar" else "Generar nueva selección", fontSize = 16.sp) }
        if (d.plan != null) OutlinedButton(onClick = { nav.navigate("preview") }, Modifier.fillMaxWidth()) { Text("Volver a la previsualización actual") }
        if (d.text.isBlank()) Hint("Escribe un texto para continuar.")
        Spacer(Modifier.height(24.dp))
    }

    if (templateDialog) {
        var name by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { templateDialog = false }, title = { Text("Guardar plantilla") },
            text = { OutlinedTextField(name, { name = it }, singleLine = true, placeholder = { Text("Nombre de la plantilla") }) },
            confirmButton = { TextButton(onClick = { vm.saveTemplate(name); templateDialog = false }) { Text("Guardar") } },
            dismissButton = { TextButton(onClick = { templateDialog = false }) { Text("Cancelar") } })
    }
}

