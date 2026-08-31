package com.markflow.editor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Microphone foreground service. It does NOT capture audio itself — AudioCapture
 * owns the AudioRecord loop — it exists so the OS keeps the process alive and the
 * microphone available while the app is backgrounded / the screen is off.
 *
 * Without a running microphone foreground service, Android (API 34+) suspends the
 * cached app process and revokes background microphone access, so a voice
 * recording silently stops the moment the user switches apps or locks the screen.
 * With this service running:
 *   - the AudioRecord loop keeps delivering samples (written to the Refine
 *     archive natively, independent of the frozen WebView JS pipeline), and
 *   - the process is not killed, so the open document / recording UI survive.
 *
 * Must be started from a user-visible Activity context (AudioCapture.start() is
 * invoked from the JS bridge while the app is foreground) — Android forbids
 * starting a microphone FGS from the background.
 */
class VoiceRecordingService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundWithNotification()
        acquireWakeLock()
        // Do not auto-restart if the OS kills us: recording state lives in the
        // WebView, which would be gone too. AudioCapture.stop() stops us cleanly.
        return START_NOT_STICKY
    }

    private fun startForegroundWithNotification() {
        val channelId = "markflow_voice_recording"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(channelId) == null) {
                val channel = NotificationChannel(
                    channelId,
                    "音声録音",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "録音中はバックグラウンドでも文字起こし用の音声を保持します"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            }
        }

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("MarkFlow で録音中")
            .setContentText("バックグラウンドでも音声を記録しています")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .apply { contentIntent?.let { setContentIntent(it) } }
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "MarkFlow::VoiceRecording",
        ).apply {
            setReferenceCounted(false)
            // Safety cap so a leaked lock can't drain the battery indefinitely;
            // normal recordings stop() well before this.
            acquire(4 * 60 * 60 * 1000L)
        }
    }

    override fun onDestroy() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
        super.onDestroy()
    }

    companion object {
        private const val NOTIFICATION_ID = 4021

        fun start(context: Context) {
            val intent = Intent(context, VoiceRecordingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoiceRecordingService::class.java))
        }
    }
}
