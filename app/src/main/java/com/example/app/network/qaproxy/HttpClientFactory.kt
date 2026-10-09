package com.example.app.network.qaproxy

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

private const val TIMEOUT_SECONDS = 30L

class HttpClientFactory(
    private val isDebugBuild: Boolean,
    private val qaProxySelector: QaProxySelector
) {

    fun create(): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        // add your interceptors, cache, authenticator here - the proxy must see the same requests production sends
        if (isDebugBuild) {
            builder.proxySelector(qaProxySelector)
        }
        return builder.build()
    }
}
