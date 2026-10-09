package com.example.app.network.qaproxy

import android.content.Context
import com.example.app.BuildConfig
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object QaProxyModule {

    @Provides
    @Singleton
    fun provideQaProxySettings(@ApplicationContext context: Context): QaProxySettings =
        QaProxySettingsImpl(
            preferences = context.getSharedPreferences("debug_settings", Context.MODE_PRIVATE),
            isDebugBuild = BuildConfig.DEBUG
        )

    @Provides
    fun provideQaProxySelector(settings: QaProxySettings): QaProxySelector = QaProxySelector(settings)

    @Provides
    fun provideDebugLaunchArguments(settings: QaProxySettings): DebugLaunchArguments = DebugLaunchArguments(settings)

    @Provides
    @Singleton
    fun provideOkHttpClient(selector: QaProxySelector): OkHttpClient =
        HttpClientFactory(isDebugBuild = BuildConfig.DEBUG, qaProxySelector = selector).create()
}
