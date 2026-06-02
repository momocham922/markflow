package com.markflow.editor

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

class AudioCapture(private val activity: MainActivity) {
    private var audioRecord: AudioRecord? = null
    private var isRecording = false
    private val buffer = mutableListOf<Float>()
    private val lock = Object()
    private var sampleRate = 16000

    fun hasPermission(): Boolean {
        return ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
    }

    fun start(): Boolean {
        if (!hasPermission()) return false
        if (isRecording) return true

        val rates = intArrayOf(16000, 44100, 48000)
        var record: AudioRecord? = null
        for (rate in rates) {
            val bufSize = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
            if (bufSize == AudioRecord.ERROR_BAD_VALUE || bufSize == AudioRecord.ERROR) continue
            try {
                val r = AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_FLOAT,
                    bufSize * 2
                )
                if (r.state == AudioRecord.STATE_INITIALIZED) {
                    record = r
                    sampleRate = rate
                    break
                }
                r.release()
            } catch (e: Exception) {
                continue
            }
        }

        if (record == null) return false
        audioRecord = record

        synchronized(lock) { buffer.clear() }
        isRecording = true
        record.startRecording()

        thread(isDaemon = true) {
            val readBuf = FloatArray(1024)
            while (isRecording) {
                val read = record.read(readBuf, 0, readBuf.size, AudioRecord.READ_BLOCKING)
                if (read > 0) {
                    synchronized(lock) {
                        for (i in 0 until read) buffer.add(readBuf[i])
                    }
                }
            }
        }

        return true
    }

    fun stop() {
        isRecording = false
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
    }

    fun getSampleRate(): Int = sampleRate

    fun drainBuffer(): FloatArray {
        synchronized(lock) {
            val data = buffer.toFloatArray()
            buffer.clear()
            return data
        }
    }

    fun getLevel(): Float {
        synchronized(lock) {
            if (buffer.isEmpty()) return 0f
            val tail = if (buffer.size > 1600) buffer.subList(buffer.size - 1600, buffer.size) else buffer
            val rms = Math.sqrt(tail.map { (it * it).toDouble() }.average()).toFloat()
            return (rms * 5f).coerceAtMost(1f)
        }
    }

    // Return base64-encoded LINEAR16 PCM chunk for STT
    fun getChunk(): String? {
        val samples = drainBuffer()
        if (samples.isEmpty()) return null

        // Resample to 16kHz if needed
        val resampled = if (sampleRate != 16000) {
            val ratio = sampleRate.toDouble() / 16000.0
            val newLen = (samples.size / ratio).toInt()
            FloatArray(newLen) { i ->
                val idx = (i * ratio).toInt().coerceAtMost(samples.size - 1)
                samples[idx]
            }
        } else samples

        // Float32 -> Int16 PCM
        val byteBuffer = ByteBuffer.allocate(resampled.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (s in resampled) {
            val clamped = s.coerceIn(-1f, 1f)
            byteBuffer.putShort((clamped * 32767f).toInt().toShort())
        }
        return Base64.encodeToString(byteBuffer.array(), Base64.NO_WRAP)
    }
}
