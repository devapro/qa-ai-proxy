package com.example.app.network.qaproxy

import android.content.SharedPreferences
import android.util.Log
import java.net.InetSocketAddress

private const val PREF_QA_PROXY_ADDRESS_KEY = "pref_qa_proxy_address"
private const val HOST_PORT_SEPARATOR = ':'
private const val LOG_TAG = "QaProxy"
private val VALID_PORTS = 1..65_535

internal class QaProxySettingsImpl(
    private val preferences: SharedPreferences,
    private val isDebugBuild: Boolean
) : QaProxySettings {

    override fun proxyAddress(): InetSocketAddress? {
        if (!isDebugBuild) return null
        return preferences.getString(PREF_QA_PROXY_ADDRESS_KEY, null)?.let(::parse)
    }

    override fun setProxyAddress(hostAndPort: String?) {
        if (!isDebugBuild) return
        if (hostAndPort == null || parse(hostAndPort) == null) {
            hostAndPort?.let { Log.w(LOG_TAG, "Ignoring invalid QA proxy address \"$it\"; expected host:port") }
            preferences.edit().remove(PREF_QA_PROXY_ADDRESS_KEY).apply()
        } else {
            preferences.edit().putString(PREF_QA_PROXY_ADDRESS_KEY, hostAndPort).apply()
        }
    }

    private fun parse(hostAndPort: String): InetSocketAddress? {
        val host = hostAndPort.substringBeforeLast(delimiter = HOST_PORT_SEPARATOR, missingDelimiterValue = "")
        val port = hostAndPort.substringAfterLast(delimiter = HOST_PORT_SEPARATOR).toIntOrNull()
        if (host.isBlank() || port == null || port !in VALID_PORTS) return null
        // Unresolved: the name is resolved per connection, so an address set before the proxy is up still works.
        return InetSocketAddress.createUnresolved(host, port)
    }
}
