package com.markflow.editor

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

class AudioCapture(private val activity: MainActivity) {
    private var audioRecord: AudioRecord? = null
    @Volatile private var isRecording = false
    private val buffer = mutableListOf<Float>()
    private val lock = Object()
    private var sampleRate = 16000
    private var useFloat = true
    private var archiveFile: FileOutputStream? = null
    private var archivePath: String? = null
    @Volatile private var adoptedOrphan = false
    private var captureThread: Thread? = null

    fun hasPermission(): Boolean {
        return ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
    }

    fun start(): Boolean {
        if (!hasPermission()) return false
        if (isRecording) return true

        val rates = intArrayOf(16000, 44100, 48000)
        var record: AudioRecord? = null

        // Try Float32 first, then fall back to Int16
        for (encoding in intArrayOf(AudioFormat.ENCODING_PCM_FLOAT, AudioFormat.ENCODING_PCM_16BIT)) {
            for (rate in rates) {
                val bufSize = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, encoding)
                if (bufSize == AudioRecord.ERROR_BAD_VALUE || bufSize == AudioRecord.ERROR) continue
                try {
                    val r = AudioRecord(
                        MediaRecorder.AudioSource.MIC,
                        rate,
                        AudioFormat.CHANNEL_IN_MONO,
                        encoding,
                        bufSize * 2
                    )
                    if (r.state == AudioRecord.STATE_INITIALIZED) {
                        record = r
                        sampleRate = rate
                        useFloat = encoding == AudioFormat.ENCODING_PCM_FLOAT
                        break
                    }
                    r.release()
                } catch (e: Exception) {
                    android.util.Log.w("MarkFlow", "AudioRecord init failed: rate=$rate enc=$encoding: ${e.message}")
                    continue
                }
            }
            if (record != null) break
        }

        if (record == null) {
            android.util.Log.e("MarkFlow", "No working AudioRecord configuration found")
            return false
        }

        audioRecord = record
        synchronized(lock) { buffer.clear() }
        isRecording = true
        record.startRecording()
        // Start the microphone foreground service so the OS keeps capturing while
        // backgrounded / screen-off (and doesn't kill the process, which would
        // close the open document). Started here — from the JS bridge on a
        // user-visible Activity — because a mic FGS cannot be started from the
        // background. Best-effort: recording still proceeds if this throws.
        try {
            VoiceRecordingService.start(activity)
        } catch (e: Exception) {
            android.util.Log.w("MarkFlow", "Foreground service start failed: ${e.message}")
        }
        android.util.Log.i("MarkFlow", "AudioRecord started: ${sampleRate}Hz, float=$useFloat")

        // Create archive temp file for Refine pipeline (16kHz mono i16 PCM)
        try {
            val tempFile = File(activity.cacheDir, "markflow_voice_${System.currentTimeMillis()}.pcm")
            archivePath = tempFile.absolutePath
            adoptedOrphan = false
            archiveFile = FileOutputStream(tempFile)
            android.util.Log.i("MarkFlow", "Archive file created: ${tempFile.absolutePath}")
        } catch (e: Exception) {
            android.util.Log.w("MarkFlow", "Failed to create archive file: ${e.message}")
            archiveFile = null
            archivePath = null
        }

        captureThread = thread(isDaemon = true) {
            if (useFloat) {
                val readBuf = FloatArray(1024)
                while (isRecording) {
                    val read = record.read(readBuf, 0, readBuf.size, AudioRecord.READ_BLOCKING)
                    if (read > 0) {
                        synchronized(lock) {
                            for (i in 0 until read) buffer.add(readBuf[i])
                            capBuffer()
                        }
                        writeToArchive(readBuf, read)
                    }
                }
            } else {
                val readBuf = ShortArray(1024)
                while (isRecording) {
                    val read = record.read(readBuf, 0, readBuf.size)
                    if (read > 0) {
                        synchronized(lock) {
                            for (i in 0 until read) buffer.add(readBuf[i].toFloat() / 32768f)
                            capBuffer()
                        }
                        writeToArchiveShort(readBuf, read)
                    }
                }
            }
        }

        return true
    }

    private fun writeToArchive(samples: FloatArray, count: Int) {
        val out = archiveFile ?: return
        try {
            // Resample to 16kHz if needed, then write as i16 PCM
            if (sampleRate != 16000) {
                val ratio = sampleRate.toDouble() / 16000.0
                val newLen = (count / ratio).toInt()
                val buf = ByteBuffer.allocate(newLen * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until newLen) {
                    val idx = (i * ratio).toInt().coerceAtMost(count - 1)
                    buf.putShort((samples[idx].coerceIn(-1f, 1f) * 32767f).toInt().toShort())
                }
                synchronized(out) { out.write(buf.array()) }
            } else {
                val buf = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until count) {
                    buf.putShort((samples[i].coerceIn(-1f, 1f) * 32767f).toInt().toShort())
                }
                synchronized(out) { out.write(buf.array()) }
            }
        } catch (e: Exception) {
            android.util.Log.w("MarkFlow", "Archive write error: ${e.message}")
        }
    }

    private fun writeToArchiveShort(samples: ShortArray, count: Int) {
        val out = archiveFile ?: return
        try {
            if (sampleRate != 16000) {
                val ratio = sampleRate.toDouble() / 16000.0
                val newLen = (count / ratio).toInt()
                val buf = ByteBuffer.allocate(newLen * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until newLen) {
                    val idx = (i * ratio).toInt().coerceAtMost(count - 1)
                    buf.putShort(samples[idx])
                }
                synchronized(out) { out.write(buf.array()) }
            } else {
                val buf = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until count) { buf.putShort(samples[i]) }
                synchronized(out) { out.write(buf.array()) }
            }
        } catch (e: Exception) {
            android.util.Log.w("MarkFlow", "Archive write error: ${e.message}")
        }
    }

    // Bound the in-memory live buffer to ~120s (must be called while holding
    // `lock`). The JS drain loop (getChunk every CHUNK_MS) is frozen while the
    // app is backgrounded, so without a cap this list would grow unbounded and
    // OOM during a long screen-off recording. The Refine archive is written
    // separately and stays complete, so capping only trims the (best-effort)
    // live-transcript backlog — mirrors the Rust MIC_BUFFER_MAX_SAMPLES cap.
    private fun capBuffer() {
        val cap = sampleRate * 120
        if (buffer.size > cap) {
            val drop = buffer.size - cap
            buffer.subList(0, drop).clear()
        }
    }

    fun stop() {
        isRecording = false
        // stop() unblocks the capture thread's pending READ_BLOCKING read so it
        // returns the final buffered samples and writes them to the archive.
        audioRecord?.stop()
        // Join the capture thread BEFORE closing the archive so its last
        // writeToArchive() completes into the still-open handle. Otherwise the
        // close() below races the final write and silently drops the last read
        // (~sub-100ms). Bounded join so stop() can never hang the UI.
        try { captureThread?.join(1000) } catch (_: InterruptedException) {}
        captureThread = null
        audioRecord?.release()
        audioRecord = null
        try { archiveFile?.close() } catch (_: Exception) {}
        archiveFile = null
        try {
            VoiceRecordingService.stop(activity)
        } catch (e: Exception) {
            android.util.Log.w("MarkFlow", "Foreground service stop failed: ${e.message}")
        }
    }

    // The archive path lives only in memory: if the process dies (crash, OS
    // kill, update) the file stays in cacheDir but Refine can no longer reach
    // it. Fall back to the newest orphaned archive so it can still be refined
    // (2026-11-09: a signed-out recording was stranded this way on iOS).
    fun getArchivePath(): String? {
        val current = archivePath
        if (current != null && File(current).exists()) return current
        if (isRecording) return null
        val orphan = findNewestOrphan() ?: return null
        archivePath = orphan.absolutePath
        adoptedOrphan = true
        android.util.Log.i("MarkFlow", "Adopted orphaned archive: ${orphan.absolutePath} (${orphan.length()} bytes)")
        return archivePath
    }

    fun hasArchive(): Boolean = getArchivePath() != null

    /** JSON {key, bytes, modifiedMs} for an adopted orphan, or null. */
    fun getOrphanArchiveInfo(): String? {
        if (isRecording) return null
        val current = archivePath
        if (current != null && File(current).exists() && !adoptedOrphan) return null
        val path = getArchivePath() ?: return null
        if (!adoptedOrphan) return null
        val f = File(path)
        if (!f.exists()) return null
        val key = f.name.replace("\\", "\\\\").replace("\"", "\\\"")
        return "{\"key\":\"$key\",\"bytes\":${f.length()},\"modifiedMs\":${f.lastModified()}}"
    }

    private fun findNewestOrphan(): File? {
        val files = activity.cacheDir.listFiles() ?: return null
        return files
            .filter { f ->
                f.isFile && f.name.startsWith("markflow_voice_") && f.name.endsWith(".pcm") &&
                    f.name.length > "markflow_voice_.pcm".length && f.length() > 32000L
            }
            .maxByOrNull { it.lastModified() }
    }

    fun clearArchive() {
        try { archiveFile?.close() } catch (_: Exception) {}
        archiveFile = null
        // An adopted orphan is the only copy of an earlier recording: release it
        // but never delete it here.
        if (!adoptedOrphan) {
            archivePath?.let {
                try { File(it).delete() } catch (_: Exception) {}
            }
        }
        archivePath = null
        adoptedOrphan = false
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

    fun getChunk(): String? {
        val samples = drainBuffer()
        if (samples.isEmpty()) return null

        val resampled = if (sampleRate != 16000) {
            val ratio = sampleRate.toDouble() / 16000.0
            val newLen = (samples.size / ratio).toInt()
            FloatArray(newLen) { i ->
                val idx = (i * ratio).toInt().coerceAtMost(samples.size - 1)
                samples[idx]
            }
        } else samples

        val byteBuffer = ByteBuffer.allocate(resampled.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (s in resampled) {
            val clamped = s.coerceIn(-1f, 1f)
            byteBuffer.putShort((clamped * 32767f).toInt().toShort())
        }
        return Base64.encodeToString(byteBuffer.array(), Base64.NO_WRAP)
    }
}
