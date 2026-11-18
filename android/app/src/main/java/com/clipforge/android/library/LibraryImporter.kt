package com.clipforge.android.library

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.clipforge.android.data.AppDao
import com.clipforge.android.data.VideoEntity
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

data class Candidate(val uri: Uri, val name: String, val size: Long, val folder: String)

data class ImportResult(val added: Int, val duplicates: Int, val skipped: Int, val failed: Int, val cancelled: Boolean)

class LibraryImporter(private val ctx: Context, private val dao: AppDao) {
    // Serializa «buscar original por huella + insertar»: sin esto, dos copias idénticas importadas a la vez se marcan ambas como originales.
    private val dedupLock = Mutex()
    private val thumbDir = File(ctx.filesDir, "thumbs").apply { mkdirs() }

    // ---------------------------------------------------------------- descubrimiento

    /** Todos los videos de la galería (MediaStore). Requiere READ_MEDIA_VIDEO / READ_EXTERNAL_STORAGE. */
    fun scanMediaStore(): List<Candidate> {
        val out = ArrayList<Candidate>()
        val collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        val proj = arrayOf(MediaStore.Video.Media._ID, MediaStore.Video.Media.DISPLAY_NAME, MediaStore.Video.Media.SIZE, MediaStore.Video.Media.RELATIVE_PATH)
        ctx.contentResolver.query(collection, proj, null, null, "${MediaStore.Video.Media.DATE_ADDED} DESC")?.use { c ->
            val iId = c.getColumnIndexOrThrow(MediaStore.Video.Media._ID)
            val iName = c.getColumnIndexOrThrow(MediaStore.Video.Media.DISPLAY_NAME)
            val iSize = c.getColumnIndexOrThrow(MediaStore.Video.Media.SIZE)
            val iRel = c.getColumnIndexOrThrow(MediaStore.Video.Media.RELATIVE_PATH)
            while (c.moveToNext()) {
                val rel = c.getString(iRel) ?: ""
                // Evita reimportar lo que ClipForge exportó.
                if (rel.contains("ClipForge", ignoreCase = true)) continue
                out.add(Candidate(Uri.withAppendedPath(collection, c.getLong(iId).toString()), c.getString(iName) ?: "video", c.getLong(iSize), rel.trimEnd('/')))
            }
        }
        return out
    }

    /** Recorre recursivamente una carpeta elegida con el selector del sistema (SAF). */
    fun scanTree(tree: Uri): List<Candidate> {
        val out = ArrayList<Candidate>()
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        fun walk(docId: String, path: String) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
            val proj = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE)
            val dirs = ArrayList<Pair<String, String>>()
            ctx.contentResolver.query(children, proj, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0)
                    val name = c.getString(1) ?: continue
                    val mime = c.getString(2) ?: ""
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) dirs.add(id to name)
                    else if (mime.startsWith("video/") || looksLikeVideo(name))
                        out.add(Candidate(DocumentsContract.buildDocumentUriUsingTree(tree, id), name, if (c.isNull(3)) 0 else c.getLong(3), path))
                }
            }
            for ((id, name) in dirs) walk(id, "$path/$name")
        }
        walk(rootId, rootId.substringAfterLast(':').ifEmpty { "Carpeta" })
        return out
    }

    fun describe(uri: Uri): Candidate {
        var name = "video"; var size = 0L
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) { name = c.getString(0) ?: name; size = if (c.isNull(1)) 0 else c.getLong(1) }
        }
        return Candidate(uri, name, size, "Archivos")
    }

    private fun looksLikeVideo(name: String) = name.substringAfterLast('.', "").lowercase() in VIDEO_EXT

    // ---------------------------------------------------------------- importación

    suspend fun import(cands: List<Candidate>, onProgress: (done: Int, total: Int, current: String) -> Unit): ImportResult = coroutineScope {
        val sem = Semaphore(4) // máximo 4 tareas simultáneas: miles de videos no bloquean ni agotan memoria
        var added = 0; var dups = 0; var skipped = 0; var failed = 0; var done = 0
        val lock = Any()
        val total = cands.size
        val jobs = cands.map { cand ->
            async(Dispatchers.IO) {
                sem.withPermit {
                    if (!isActive) return@withPermit
                    val r = try { importOne(cand) } catch (e: CancellationException) { throw e } catch (_: Exception) { -1 }
                    synchronized(lock) {
                        when (r) { 1 -> added++; 2 -> { added++; dups++ }; 0 -> skipped++; else -> failed++ }
                        done++
                    }
                    onProgress(done, total, cand.name)
                }
            }
        }
        try { jobs.awaitAll() } catch (e: CancellationException) { jobs.forEach { it.cancel() }; return@coroutineScope ImportResult(added, dups, skipped, failed, true) }
        ImportResult(added, dups, skipped, failed, false)
    }

    /** 0 = ya existía, 1 = añadido, 2 = añadido como duplicado, -1 = error. */
    private suspend fun importOne(c: Candidate): Int {
        val uriStr = c.uri.toString()
        if (dao.countUri(uriStr) > 0) return 0
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(ctx, c.uri)
            val durMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: return -1
            if (durMs <= 0) return -1
            var w = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            var h = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rot = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (rot == 90 || rot == 270) { val t = w; w = h; h = t }
            if (w <= 0 || h <= 0) return -1 // sin pista de video
            val fps = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull() ?: 0.0
            val hasAudio = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
            val mime = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE) ?: ""
            val format = c.name.substringAfterLast('.', "").lowercase().ifEmpty { mime.substringAfter('/') }
            val size = if (c.size > 0) c.size else sizeOf(c.uri)

            val hash = quickHash(ctx.contentResolver, c.uri, size)

            // Miniatura a ~1/3 del video (evita pantallas negras iniciales).
            val frame = mmr.getFrameAtTime((durMs * 1000L) / 3, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            var thumb: String? = null
            if (frame != null) {
                val tw = 360; val th = (frame.height * tw.toFloat() / frame.width).toInt().coerceAtLeast(1)
                val scaled = Bitmap.createScaledBitmap(frame, tw, th, true)
                val f = File(thumbDir, "${System.nanoTime()}.jpg")
                f.outputStream().use { scaled.compress(Bitmap.CompressFormat.JPEG, 80, it) }
                thumb = f.absolutePath
                if (scaled !== frame) scaled.recycle()
                frame.recycle()
            }
            var orig: Long? = null
            val id = dedupLock.withLock {
                orig = if (hash.isNotEmpty()) dao.originalByHash(hash) else null
                dao.insertVideo(VideoEntity(
                uri = uriStr, name = c.name, folder = c.folder, duration = durMs / 1000.0, width = w, height = h, fps = fps,
                format = format, size = size, hasAudio = hasAudio, hash = hash, thumb = thumb, dupOf = orig, addedAt = System.currentTimeMillis()
                ))
            }
            if (id <= 0) { thumb?.let { File(it).delete() }; return 0 }
            return if (orig != null) 2 else 1
        } finally {
            try { mmr.release() } catch (_: Exception) {}
        }
    }

    private fun sizeOf(uri: Uri): Long = try { ctx.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: 0L } catch (_: Exception) { 0L }

    /** Huella rápida: tamaño + 3 bloques de 128 KB (inicio, medio y final). */
    private fun quickHash(cr: ContentResolver, uri: Uri, size: Long): String {
        return try {
            cr.openFileDescriptor(uri, "r")?.use { pfd ->
                FileInputStream(pfd.fileDescriptor).channel.use { ch ->
                    val md = MessageDigest.getInstance("SHA-1")
                    md.update(size.toString().toByteArray())
                    val block = 128 * 1024
                    val len = ch.size()
                    val buf = java.nio.ByteBuffer.allocate(block)
                    for (pos in longArrayOf(0, maxOf(0, len / 2 - block / 2), maxOf(0, len - block))) {
                        buf.clear()
                        val n = ch.read(buf, pos)
                        if (n > 0) md.update(buf.array(), 0, n)
                    }
                    md.digest().joinToString("") { "%02x".format(it) }
                }
            } ?: ""
        } catch (_: Exception) { "" }
    }

    /** Marca como desconectados los videos cuyo archivo ya no se puede abrir (disco externo, nube...). */
    suspend fun verify(all: List<VideoEntity>): Int = withContext(Dispatchers.IO) {
        var changed = 0
        for (v in all) {
            val ok = try { ctx.contentResolver.openFileDescriptor(Uri.parse(v.uri), "r")?.use { true } ?: false } catch (_: Exception) { false }
            if (ok == v.missing) { dao.setMissing(v.id, !ok); changed++ }
        }
        changed
    }

    fun deleteThumb(path: String?) { path?.let { try { File(it).delete() } catch (_: Exception) {} } }

    companion object {
        val VIDEO_EXT = setOf("mp4", "mov", "m4v", "mkv", "webm", "avi", "3gp", "ts", "mts", "m2ts", "wmv", "flv")
    }
}
