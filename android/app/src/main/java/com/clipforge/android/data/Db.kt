package com.clipforge.android.data

import android.content.Context
import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "videos", indices = [Index("hash"), Index(value = ["uri"], unique = true)])
data class VideoEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val uri: String,
    val name: String,
    val folder: String,
    val duration: Double,
    val width: Int,
    val height: Int,
    val fps: Double,
    val format: String,
    val size: Long,
    val hasAudio: Boolean,
    val hash: String,
    val thumb: String?,
    val dupOf: Long?,
    val missing: Boolean = false,
    val addedAt: Long,
    val score: Double? = null
)

@Entity(tableName = "used_segments")
data class UsedSegmentEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val videoId: Long,
    val start: Double,
    val duration: Double,
    val createdAt: Long
)

@Entity(tableName = "projects")
data class ProjectEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val draftJson: String,
    val updatedAt: Long
)

@Entity(tableName = "outputs")
data class OutputEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val projectId: Long,
    val uri: String,
    val name: String,
    val duration: Double,
    val size: Long,
    val comboKey: String,
    val createdAt: Long
)

@Entity(tableName = "text_templates")
data class TemplateEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val styleJson: String
)

data class LibraryStats(val count: Int, val duplicates: Int, val totalSize: Long, val totalDuration: Double)

@Dao
interface AppDao {
    // ---- videos
    @Query("SELECT * FROM videos ORDER BY addedAt DESC, id DESC")
    fun videos(): Flow<List<VideoEntity>>

    @Query("SELECT * FROM videos WHERE missing = 0 AND dupOf IS NULL")
    suspend fun usableVideos(): List<VideoEntity>

    @Query("SELECT * FROM videos WHERE id = :id")
    suspend fun video(id: Long): VideoEntity?

    @Query("SELECT * FROM videos WHERE id IN (:ids)")
    suspend fun videosByIds(ids: List<Long>): List<VideoEntity>

    @Query("SELECT COUNT(*) FROM videos WHERE uri = :uri")
    suspend fun countUri(uri: String): Int

    @Query("SELECT id FROM videos WHERE hash = :hash AND dupOf IS NULL ORDER BY id LIMIT 1")
    suspend fun originalByHash(hash: String): Long?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertVideo(v: VideoEntity): Long

    @Query("DELETE FROM videos WHERE id = :id")
    suspend fun deleteVideo(id: Long)

    @Query("UPDATE videos SET missing = :missing WHERE id = :id")
    suspend fun setMissing(id: Long, missing: Boolean)

    @Query("UPDATE videos SET score = :score WHERE id = :id")
    suspend fun setScore(id: Long, score: Double)

    @Query("SELECT COUNT(*) AS count, SUM(CASE WHEN dupOf IS NOT NULL THEN 1 ELSE 0 END) AS duplicates, COALESCE(SUM(size),0) AS totalSize, COALESCE(SUM(duration),0) AS totalDuration FROM videos")
    fun stats(): Flow<LibraryStats>

    // ---- historial de fragmentos usados
    @Query("SELECT * FROM used_segments")
    suspend fun usedSegments(): List<UsedSegmentEntity>

    @Insert
    suspend fun insertUsed(rows: List<UsedSegmentEntity>)

    @Query("DELETE FROM used_segments")
    suspend fun clearUsed()

    // ---- proyectos
    @Query("SELECT * FROM projects ORDER BY updatedAt DESC")
    fun projects(): Flow<List<ProjectEntity>>

    @Query("SELECT * FROM projects WHERE id = :id")
    suspend fun project(id: Long): ProjectEntity?

    @Query("SELECT * FROM projects ORDER BY updatedAt DESC LIMIT 1")
    suspend fun lastProject(): ProjectEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProject(p: ProjectEntity): Long

    @Query("DELETE FROM projects WHERE id = :id")
    suspend fun deleteProject(id: Long)

    // ---- videos generados
    @Query("SELECT * FROM outputs ORDER BY createdAt DESC")
    fun outputs(): Flow<List<OutputEntity>>

    @Query("SELECT comboKey FROM outputs")
    suspend fun comboKeys(): List<String>

    @Insert
    suspend fun insertOutput(o: OutputEntity): Long

    @Query("DELETE FROM outputs WHERE id = :id")
    suspend fun deleteOutput(id: Long)

    // ---- plantillas de texto
    @Query("SELECT * FROM text_templates ORDER BY id DESC")
    fun templates(): Flow<List<TemplateEntity>>

    @Insert
    suspend fun insertTemplate(t: TemplateEntity): Long

    @Query("DELETE FROM text_templates WHERE id = :id")
    suspend fun deleteTemplate(id: Long)
}

@Database(
    entities = [VideoEntity::class, UsedSegmentEntity::class, ProjectEntity::class, OutputEntity::class, TemplateEntity::class],
    version = 1, exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun dao(): AppDao

    companion object {
        fun create(ctx: Context): AppDatabase =
            Room.databaseBuilder(ctx, AppDatabase::class.java, "clipforge.db").build()
    }
}
