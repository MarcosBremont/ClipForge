package com.clipforge.android.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import com.clipforge.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

data class Release(val version: String, val notes: String, val apkUrl: String, val sha256: String?, val size: Long)

/**
 * Actualizaciones desde GitHub Releases. Las versiones de Android se publican con etiquetas `android-vX.Y.Z`
 * (para no mezclarlas con las de escritorio `vX.Y.Z`). Android solo instala el APK si está firmado con la misma clave.
 */
object Updater {
    private const val OWNER = "MarcosBremont"
    private const val REPO = "ClipForge"
    private const val PREFIX = "android-v"

    fun versionParts(v: String) = v.trim().removePrefix("v").split('.').map { it.takeWhile { c -> c.isDigit() }.toIntOrNull() ?: 0 }
    fun isNewer(candidate: String, current: String): Boolean {
        val a = versionParts(candidate); val b = versionParts(current)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }; val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** Devuelve la última versión publicada, o null si la instalada ya es la última. Lanza con mensaje claro si falla. */
    suspend fun check(current: String = BuildConfig.VERSION_NAME): Release? = withContext(Dispatchers.IO) {
        val con = URL("https://api.github.com/repos/$OWNER/$REPO/releases?per_page=30").openConnection() as HttpURLConnection
        try {
            con.connectTimeout = 15000; con.readTimeout = 20000
            con.setRequestProperty("Accept", "application/vnd.github+json")
            val code = con.responseCode
            if (code == 404) throw IllegalStateException("No se encontró el repositorio de actualizaciones (debe ser público).")
            if (code == 403) throw IllegalStateException("GitHub limitó las consultas; reintenta en unos minutos.")
            if (code !in 200..299) throw IllegalStateException("GitHub respondió $code.")
            val arr = JSONArray(con.inputStream.bufferedReader().use { it.readText() })
            var best: Release? = null
            for (i in 0 until arr.length()) {
                val r = arr.getJSONObject(i)
                val tag = r.optString("tag_name")
                if (!tag.startsWith(PREFIX) || r.optBoolean("draft") || r.optBoolean("prerelease")) continue
                val version = tag.removePrefix(PREFIX)
                val assets = r.optJSONArray("assets") ?: continue
                for (j in 0 until assets.length()) {
                    val a = assets.getJSONObject(j)
                    if (!a.optString("name").endsWith(".apk")) continue
                    val rel = Release(version, r.optString("body"), a.getString("browser_download_url"),
                        a.optString("digest").removePrefix("sha256:").takeIf { it.length == 64 }, a.optLong("size"))
                    if (best == null || isNewer(rel.version, best.version)) best = rel
                    break
                }
            }
            if (best != null && isNewer(best.version, current)) best else null
        } catch (e: java.io.IOException) {
            throw IllegalStateException("No hay conexión con el servidor de actualizaciones.")
        } finally { con.disconnect() }
    }

    suspend fun download(ctx: Context, r: Release, onProgress: (Int) -> Unit): File = withContext(Dispatchers.IO) {
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        val out = File(dir, "ClipForge-${r.version}.apk")
        val con = URL(r.apkUrl).openConnection() as HttpURLConnection
        try {
            con.connectTimeout = 15000; con.readTimeout = 30000
            val total = con.contentLengthLong.takeIf { it > 0 } ?: r.size
            val md = MessageDigest.getInstance("SHA-256")
            var done = 0L
            con.inputStream.use { input -> out.outputStream().use { o ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf); if (n < 0) break
                    o.write(buf, 0, n); md.update(buf, 0, n); done += n
                    if (total > 0) onProgress((done * 100 / total).toInt())
                }
            } }
            val hex = md.digest().joinToString("") { "%02x".format(it) }
            if (r.sha256 != null && !hex.equals(r.sha256, true)) { out.delete(); throw IllegalStateException("La descarga está dañada (la suma de verificación no coincide).") }
            out
        } finally { con.disconnect() }
    }

    /** Abre el instalador del sistema. Si falta el permiso de «instalar apps desconocidas», lleva al usuario a concederlo. */
    fun install(ctx: Context, apk: File): Boolean {
        if (!ctx.packageManager.canRequestPackageInstalls()) {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", apk)
        ctx.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
    }
}
