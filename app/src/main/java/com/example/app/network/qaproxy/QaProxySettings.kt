package com.example.app.network.qaproxy

import java.net.InetSocketAddress

interface QaProxySettings {

    fun proxyAddress(): InetSocketAddress?

    fun setProxyAddress(hostAndPort: String?)
}
