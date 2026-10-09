package com.example.app.network.qaproxy

import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI

private val API_URI: URI = URI.create("https://api.example.com/users/v1/profile")
private val QA_PROXY_ADDRESS: InetSocketAddress = InetSocketAddress.createUnresolved("10.0.2.2", 8080)

class QaProxySelectorTest {

    private val qaProxySettings = mockk<QaProxySettings>()
    private val systemProxySelector = mockk<ProxySelector>(relaxed = true)
    private val selector = QaProxySelector(qaProxySettings)
    private var originalDefault: ProxySelector? = null

    @Before
    fun setUp() {
        originalDefault = ProxySelector.getDefault()
        ProxySelector.setDefault(systemProxySelector)
    }

    @After
    fun tearDown() {
        ProxySelector.setDefault(originalDefault)
    }

    @Test
    fun `select routes through the QA proxy first and falls back to direct when an address is set`() {
        every { qaProxySettings.proxyAddress() } returns QA_PROXY_ADDRESS

        val actual = selector.select(API_URI)

        assertThat(actual).isEqualTo(listOf(Proxy(Proxy.Type.HTTP, QA_PROXY_ADDRESS), Proxy.NO_PROXY))
    }

    @Test
    fun `select delegates to the system selector when no QA proxy is set`() {
        val systemProxy = Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("corp-proxy", 3128))
        every { qaProxySettings.proxyAddress() } returns null
        every { systemProxySelector.select(API_URI) } returns listOf(systemProxy)

        val actual = selector.select(API_URI)

        assertThat(actual).isEqualTo(listOf(systemProxy))
    }

    @Test
    fun `connectFailed is not reported to the system selector for the QA proxy route`() {
        every { qaProxySettings.proxyAddress() } returns QA_PROXY_ADDRESS

        selector.connectFailed(API_URI, QA_PROXY_ADDRESS, IOException("refused"))

        verify(exactly = 0) { systemProxySelector.connectFailed(any(), any(), any()) }
    }
}
