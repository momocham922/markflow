package com.markflow.editor

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
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
  // Soft-keyboard (IME) height in CSS px (dp), measured from the ime WindowInsets
  // ABOVE the nav bar that content already reserves. Under enforced edge-to-edge
  // (targetSdk 35+) the OS neither pans nor reliably resizes the WebView for the
  // IME, and window.visualViewport is unreliable on Android (Tauri #10631), so we
  // measure it natively and push it to CSS as --android-ime-bottom. The web layer
  // reconciles this with window.innerHeight so the layout is correct whether or
  // not the framework resizes the WebView. Hidden keyboard → 0.
  private var imeBottomPx = 0

  private val requestPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { _ -> }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Select resize (not pan) semantics for the soft keyboard. Without an
    // explicit mode Android resolves UNSPECIFIED to panning the whole decor view
    // up for a full-bleed WebView, which drifts the ENTIRE UI upward on input
    // focus. Set it both here (survives any manifest regeneration) and in the
    // manifest. The web layer measures the resulting IME inset and repositions
    // itself; see imeBottomPx / --android-ime-bottom.
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
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
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val density = resources.displayMetrics.density
      insetBottomPx = (bars.bottom / density).toInt()
      // Keyboard height ABOVE the nav-bar region that content already reserves
      // via --android-safe-bottom (subtract to avoid double-counting the nav
      // bar). Hidden keyboard → ime.bottom == 0 → imeBottomPx == 0. This
      // listener re-fires on every IME animation frame, so the value tracks the
      // keyboard as it slides in/out.
      imeBottomPx = (maxOf(0, ime.bottom - bars.bottom) / density).toInt()
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
    // Set both inset vars and fire a DOM event so the web layer (use-ios-keyboard
    // Android branch) can react to keyboard show/hide immediately instead of
    // polling. document is guaranteed to exist; the event is a no-op if nothing
    // is listening yet (the CSS vars are still applied for later reads).
    webView.evaluateJavascript(
      "(function(d){" +
        "d.documentElement.style.setProperty('--android-safe-bottom','${insetBottomPx}px');" +
        "d.documentElement.style.setProperty('--android-ime-bottom','${imeBottomPx}px');" +
        "d.dispatchEvent(new Event('markflow-android-insets'));" +
        "})(document);",
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
