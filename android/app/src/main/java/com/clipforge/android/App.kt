package com.clipforge.android

import android.app.Application

class App : Application() {
    lateinit var services: Services
        private set

    override fun onCreate() {
        super.onCreate()
        services = Services(this)
    }
}
