package com.markflow.editor

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  lateinit var audioCapture: AudioCapture

  private val requestPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { _ -> }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    audioCapture = AudioCapture(this)

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      requestPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    // Add JS bridge to WebView
    window.decorView.post {
      findWebView(window.decorView as? ViewGroup)?.let { webView ->
        webView.addJavascriptInterface(AudioBridge(this), "AndroidAudio")
      }
    }
  }

  private fun findWebView(viewGroup: ViewGroup?): WebView? {
    viewGroup ?: return null
    for (i in 0 until viewGroup.childCount) {
      val child = viewGroup.getChildAt(i)
      if (child is WebView) return child
      if (child is ViewGroup) {
        findWebView(child)?.let { return it }
      }
    }
    return null
  }
}

class AudioBridge(private val activity: MainActivity) {
  @JavascriptInterface
  fun start(): Boolean = activity.audioCapture.start()

  @JavascriptInterface
  fun stop() = activity.audioCapture.stop()

  @JavascriptInterface
  fun hasPermission(): Boolean = activity.audioCapture.hasPermission()

  @JavascriptInterface
  fun getSampleRate(): Int = activity.audioCapture.getSampleRate()

  @JavascriptInterface
  fun getLevel(): Float = activity.audioCapture.getLevel()

  @JavascriptInterface
  fun getChunk(): String? = activity.audioCapture.getChunk()
}
