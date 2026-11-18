package com.clipforge.android

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.clipforge.android.data.AppDatabase
import com.clipforge.android.library.LibraryImporter

/** Contenedor de dependencias de la app (sin framework de inyección: pocas piezas, simple). */
class Services(val app: Application) {
    val db: AppDatabase by lazy { AppDatabase.create(app) }
    val dao get() = db.dao()
    val importer: LibraryImporter by lazy { LibraryImporter(app, dao) }
    val prefs: SharedPreferences by lazy { app.getSharedPreferences("clipforge", Context.MODE_PRIVATE) }

    /** Claves de IA cifradas con Android Keystore. Si el cifrado no está disponible, no se guardan (nunca en claro). */
    val secrets: SharedPreferences? by lazy {
        try {
            val mk = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            EncryptedSharedPreferences.create(app, "clipforge_secrets", mk,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
        } catch (_: Exception) { null }
    }
}

val Context.services: Services get() = (applicationContext as App).services
