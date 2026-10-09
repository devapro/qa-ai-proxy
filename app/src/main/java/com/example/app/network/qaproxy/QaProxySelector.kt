package com.example.app.network.qaproxy

import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI

class QaProxySelector(
    private val qaProxySettings: QaProxySettings
) : ProxySelector() {

    override fun select(uri: URI?): List<Proxy> {
        val qaProxyAddress = qaProxySettings.proxyAddress()
            ?: return getDefault()?.select(uri) ?: listOf(Proxy.NO_PROXY)
        // DIRECT second: OkHttp falls back to the next route when the proxy refuses the connection, so an
        // address left behind after the QA proxy stops does not cut the app off the network.
        return listOf(Proxy(Proxy.Type.HTTP, qaProxyAddress), Proxy.NO_PROXY)
    }

    override fun connectFailed(uri: URI?, address: SocketAddress?, exception: IOException?) {
        if (qaProxySettings.proxyAddress() == null) {
            getDefault()?.connectFailed(uri, address, exception)
        }
    }
}
