package com.markflow.editor

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var pendingPermissionRequest: PermissionRequest? = null

  private val requestPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { isGranted ->
    val req = pendingPermissionRequest
    pendingPermissionRequest = null
    if (isGranted && req != null) {
      req.grant(req.resources)
    } else {
      req?.deny()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Request mic permission early
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      requestPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    // Find WebView and configure audio permissions after layout is ready
    window.decorView.post {
      findWebView(window.decorView as? ViewGroup)?.let { webView ->
        webView.settings.mediaPlaybackRequiresUserGesture = false
        val existingClient = webView.webChromeClient
        webView.webChromeClient = object : WebChromeClient() {
          override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
              val resources = request.resources
              if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                  request.grant(resources)
                } else {
                  pendingPermissionRequest = request
                  requestPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                }
              } else {
                request.grant(resources)
              }
            }
          }

          override fun onProgressChanged(view: WebView?, newProgress: Int) {
            existingClient?.onProgressChanged(view, newProgress)
          }
        }
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
