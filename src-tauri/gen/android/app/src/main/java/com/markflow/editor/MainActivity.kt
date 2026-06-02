package com.markflow.editor

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
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

    // Try to inject JS bridge with increasing delays
    val handler = Handler(Looper.getMainLooper())
    for (delay in longArrayOf(500, 1500, 3000, 5000)) {
      handler.postDelayed({
        val webView = findWebViewDeep(window.decorView)
        if (webView != null) {
          try {
            webView.addJavascriptInterface(AudioBridge(this), "AndroidAudio")
            android.util.Log.i("MarkFlow", "JS bridge injected at ${delay}ms, WebView class: ${webView.javaClass.name}")
          } catch (e: Exception) {
            android.util.Log.e("MarkFlow", "Failed to inject JS bridge: ${e.message}")
          }
        } else {
          android.util.Log.w("MarkFlow", "WebView not found at ${delay}ms")
        }
      }, delay)
    }
  }

  private fun findWebViewDeep(view: View?): WebView? {
    if (view == null) return null
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        findWebViewDeep(view.getChildAt(i))?.let { return it }
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
