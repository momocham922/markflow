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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  lateinit var audioCapture: AudioCapture

  // The AudioBridge only becomes visible to JavaScript after the NEXT page load,
  // so we reload the WebView exactly once right after injecting it. Without this
  // reload window.AndroidAudio stays undefined and voice recording is stuck on
  // "初期化中" (the JS side keeps waiting for the bridge).
  private var bridgeBound = false
  // Real OS navigation-bar inset in CSS px (dp). Android's WebView does NOT
  // surface it via env(safe-area-inset-bottom) (always 0), so we measure the
  // actual WindowInsets and push the value into CSS as --android-safe-bottom.
  private var insetBottomPx = 0

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

    // Measure the real system-bar insets (measure-then-derive: derived from the
    // actual WindowInsets, never a hardcoded nav-bar height) and expose the
    // bottom inset to CSS. Insets are returned UNCONSUMED so Tauri's own view
    // still lays out normally.
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      insetBottomPx = (bars.bottom / resources.displayMetrics.density).toInt()
      findWebViewDeep(window.decorView)?.let { injectSafeAreaVars(it) }
      insets
    }
    window.decorView.requestApplyInsets()

    // Try to inject JS bridge with increasing delays, then reload ONCE so the
    // interface binds into the JS context (Android quirk — see bridgeBound).
    val handler = Handler(Looper.getMainLooper())
    for (delay in longArrayOf(500, 1500, 3000, 5000)) {
      handler.postDelayed({
        val webView = findWebViewDeep(window.decorView)
        if (webView == null) {
          android.util.Log.w("MarkFlow", "WebView not found at ${delay}ms")
          return@postDelayed
        }
        if (bridgeBound) return@postDelayed
        try {
          webView.addJavascriptInterface(AudioBridge(this), "AndroidAudio")
          webView.reload()
          bridgeBound = true
          android.util.Log.i("MarkFlow", "JS bridge injected + reloaded at ${delay}ms, WebView class: ${webView.javaClass.name}")
          // The reload replaces the document, dropping the CSS vars set on
          // <html>. Re-apply them once the fresh page has settled.
          handler.postDelayed({
            injectSafeAreaVars(webView)
            webView.requestApplyInsets()
          }, 1200)
        } catch (e: Exception) {
          android.util.Log.e("MarkFlow", "Failed to inject JS bridge: ${e.message}")
        }
      }, delay)
    }
  }

  private fun injectSafeAreaVars(webView: WebView) {
    webView.evaluateJavascript(
      "document.documentElement.style.setProperty('--android-safe-bottom','${insetBottomPx}px');",
      null,
    )
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

  @JavascriptInterface
  fun getArchivePath(): String? = activity.audioCapture.getArchivePath()

  @JavascriptInterface
  fun clearArchive() = activity.audioCapture.clearArchive()
}
