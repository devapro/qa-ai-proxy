package com.example.app.network.qaproxy

import android.content.Intent

private const val QA_PROXY_EXTRA = "debug_qa_proxy"
private const val QA_PROXY_DISABLED_VALUE = "none"

class DebugLaunchArguments(
    private val qaProxySettings: QaProxySettings
) {

    fun apply(intent: Intent) {
        if (!intent.hasExtra(QA_PROXY_EXTRA)) return
        val hostAndPort = intent.getStringExtra(QA_PROXY_EXTRA).orEmpty().trim()
        qaProxySettings.setProxyAddress(
            hostAndPort = hostAndPort.takeUnless { it.isEmpty() || it == QA_PROXY_DISABLED_VALUE }
        )
    }
}
