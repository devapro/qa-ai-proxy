package com.example.app.network.qaproxy

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.example.app.BuildConfig
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class LauncherActivity : AppCompatActivity() {

    @Inject
    lateinit var debugLaunchArguments: DebugLaunchArguments

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.DEBUG) {
            debugLaunchArguments.apply(intent)
        }
        // ... continue to the main screen
    }
}
