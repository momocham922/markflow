package com.markflow.editor

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
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

    // Request mic permission at startup so WebView getUserMedia works
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      requestPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) {
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
  }
}
