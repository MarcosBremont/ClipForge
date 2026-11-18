package com.clipforge.android

import com.clipforge.android.update.Updater
import org.junit.Assert.*
import org.junit.Test

class UpdaterTest {
    @Test fun comparaVersionesNumericamente() {
        assertTrue(Updater.isNewer("1.0.1", "1.0.0"))
        assertTrue(Updater.isNewer("1.10.0", "1.9.9")) // 10 > 9, no comparación de texto
        assertTrue(Updater.isNewer("2.0.0", "1.99.99"))
        assertTrue(Updater.isNewer("1.0.0.1", "1.0.0"))
        assertFalse(Updater.isNewer("1.0.0", "1.0.0"))
        assertFalse(Updater.isNewer("1.0.0", "1.0.1"))
        assertFalse(Updater.isNewer("0.9.9", "1.0.0"))
    }

    @Test fun toleraPrefijosYSufijos() {
        assertTrue(Updater.isNewer("v1.2.0", "1.1.0"))
        assertFalse(Updater.isNewer("1.2.0-beta", "1.2.0"))
    }
}
