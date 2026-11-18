package com.clipforge.android.export

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.clipforge.android.MainActivity
import com.clipforge.android.R
import com.clipforge.android.data.OutputEntity
import com.clipforge.android.data.UsedSegmentEntity
import com.clipforge.android.model.Segment
import com.clipforge.android.planner.comboKey
import com.clipforge.android.planner.totalDuration
import com.clipforge.android.services
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import java.io.File

data class ExportItem(val spec: ExportSpec, val segments: List<Segment>)
data class ExportBatch(val projectId: Long, val items: List<ExportItem>)

data class ExportState(
    val running: Boolean = false,
    val index: Int = 0,
    val total: Int = 0,
    val progress: Float = 0f,
    val currentName: String = "",
    val finished: List<Long> = emptyList(), // ids de OutputEntity creados
    val error: String? = null,
    val cancelled: Boolean = false
)

/** Estado compartido entre el servicio de exportación y la interfaz. */
object ExportManager {
    val state = MutableStateFlow(ExportState())
    @Volatile var pending: ExportBatch? = null
    @Volatile var job: Job? = null
    fun dismiss() { if (!state.value.running) state.value = ExportState() }
}

/** Servicio en primer plano: la exportación sigue aunque cierres la app. */
class ExportService : Service() {
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) { ExportManager.job?.cancel(); return START_NOT_STICKY }
        val batch = ExportManager.pending
        if (batch == null || ExportManager.job?.isActive == true) { if (batch == null) stopSelf(); return START_NOT_STICKY }
        ExportManager.pending = null
        createChannel()
        startForeground(NOTIF_ID, notification("Preparando exportación…", 0, true), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        ExportManager.job = scope.launch { runBatch(batch) }
        return START_NOT_STICKY
    }

    private suspend fun runBatch(batch: ExportBatch) {
        val st = ExportManager.state
        st.value = ExportState(running = true, total = batch.items.size)
        val exporter = Exporter(this)
        val dao = services.dao
        val tmpDir = File(cacheDir, "exports").apply { mkdirs() }
        val finished = mutableListOf<Long>()
        try {
            batch.items.forEachIndexed { i, item ->
                st.update { it.copy(index = i + 1, progress = 0f, currentName = item.spec.name) }
                val part = File(tmpDir, "${item.spec.name}.part.mp4")
                try {
                    exporter.render(item.spec, part) { p ->
                        st.update { it.copy(progress = p) }
                        notify("Versión ${i + 1} de ${batch.items.size}", ((i + p) / batch.items.size * 100).toInt())
                    }
                    // Escritura atómica: se renombra solo cuando FFmpeg/Transformer terminó bien.
                    val done = File(tmpDir, "${item.spec.name}.mp4")
                    if (done.exists()) done.delete()
                    if (!part.renameTo(done)) throw IllegalStateException("No se pudo finalizar el archivo")
                    val uri = withContext(Dispatchers.IO) { exporter.saveToMovies(done, "${item.spec.name}.mp4") }
                    val size = withContext(Dispatchers.IO) { done.length().also { done.delete() } }
                    val id = withContext(Dispatchers.IO) {
                        dao.insertUsed(item.segments.map { UsedSegmentEntity(videoId = it.videoId, start = it.start, duration = it.duration, createdAt = System.currentTimeMillis()) })
                        dao.insertOutput(OutputEntity(projectId = batch.projectId, uri = uri.toString(), name = "${item.spec.name}.mp4",
                            duration = totalDuration(item.segments), size = size, comboKey = comboKey(item.segments), createdAt = System.currentTimeMillis()))
                    }
                    finished.add(id)
                    st.update { it.copy(finished = finished.toList()) }
                } finally { part.delete() }
            }
            st.update { it.copy(running = false, progress = 1f) }
            finalNotification("Exportación completada", "${finished.size} video(s) guardados en Movies/ClipForge")
        } catch (e: CancellationException) {
            st.update { it.copy(running = false, cancelled = true) }
            finalNotification("Exportación cancelada", "")
        } catch (e: Throwable) {
            st.update { it.copy(running = false, error = friendly(e)) }
            finalNotification("Error al exportar", friendly(e))
        } finally {
            stopForeground(STOP_FOREGROUND_DETACH)
            stopSelf()
        }
    }

    private fun friendly(e: Throwable): String {
        val m = e.message ?: e.javaClass.simpleName
        return when {
            m.contains("ENOSPC", true) || m.contains("space", true) -> "No hay espacio suficiente en el teléfono."
            m.contains("codec", true) || m.contains("encoder", true) || m.contains("decoder", true) ->
                "El teléfono no pudo codificar/decodificar uno de los videos ($m). Prueba con calidad «rápida» o cambia ese fragmento."
            else -> m.take(220)
        }
    }

    // ---------------------------------------------------------------- notificaciones

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Exportación de videos", NotificationManager.IMPORTANCE_LOW))
    }

    private fun openApp() = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)

    private fun notification(text: String, percent: Int, indeterminate: Boolean = false): Notification {
        val cancel = PendingIntent.getService(this, 1, Intent(this, ExportService::class.java).setAction(ACTION_CANCEL), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle("ClipForge exportando").setContentText(text)
            .setProgress(100, percent, indeterminate).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(openApp())
            .addAction(0, "Cancelar", cancel).build()
    }

    private fun notify(text: String, percent: Int) =
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification(text, percent))

    private fun finalNotification(title: String, text: String) {
        val n = NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title).setContentText(text).setAutoCancel(true).setContentIntent(openApp()).build()
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID + 1, n)
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    companion object {
        private const val CHANNEL = "export"
        private const val NOTIF_ID = 42
        const val ACTION_CANCEL = "com.clipforge.android.CANCEL_EXPORT"

        fun start(ctx: Context, batch: ExportBatch) {
            ExportManager.pending = batch
            ContextCompat.startForegroundService(ctx, Intent(ctx, ExportService::class.java))
        }

        fun cancel(ctx: Context) { ctx.startService(Intent(ctx, ExportService::class.java).setAction(ACTION_CANCEL)) }
    }
}
