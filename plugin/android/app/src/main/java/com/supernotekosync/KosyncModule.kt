package com.supernotekosync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import com.ratta.supernote.pluginlib.api.HostDataCacheAPI
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection

/**
 * Device-side services for the KOSync plugin: KOReader document digests, encrypted
 * credential storage, HTTP to the KOSync server, per-book state, a tick timer and a
 * bounded diagnostics log. All reading-position decisions live in JavaScript.
 */
class KosyncModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val work = Executors.newFixedThreadPool(2)
    private val clock = Executors.newSingleThreadScheduledExecutor()
    private var ticker: ScheduledFuture<*>? = null
    private val lock = Any()
    @Volatile private var disposed = false
    private val prefs = context.getSharedPreferences("kosync_v1", Context.MODE_PRIVATE)
    private val keyAlias = "kosync_credentials_v1"

    override fun getName() = "KosyncNative"

    private fun run(promise: Promise, operation: () -> Any?) {
        if (disposed) { promise.reject("DISPOSED", "Plugin stopped"); return }
        try {
            work.execute {
                try { promise.resolve(operation()) }
                catch (error: Exception) { promise.reject("KOSYNC", error.message ?: error.javaClass.simpleName) }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            promise.reject("DISPOSED", "Plugin stopped")
        }
    }

    // ---- Ticker -----------------------------------------------------------------------

    @ReactMethod fun startTicker(intervalMs: Double, promise: Promise) {
        synchronized(lock) {
            if (disposed) { promise.reject("DISPOSED", "Plugin stopped"); return }
            ticker?.cancel(false)
            val interval = intervalMs.toLong().coerceIn(1000, 60000)
            ticker = clock.scheduleAtFixedRate({
                try {
                    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                    if (power.isInteractive && context.hasActiveReactInstance()) {
                        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit("kosync_tick", null)
                    }
                } catch (_: Exception) { /* The context may be shutting down; keep later ticks alive. */ }
            }, interval, interval, TimeUnit.MILLISECONDS)
        }
        promise.resolve(true)
    }

    /**
     * Resolves after `ms`. PluginHost freezes JavaScript timers while the plugin view
     * is hidden, so every wait in the plugin goes through native scheduling.
     */
    @ReactMethod fun sleep(ms: Double, promise: Promise) {
        try {
            clock.schedule({ promise.resolve(true) }, ms.toLong().coerceIn(0, 600000), TimeUnit.MILLISECONDS)
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            promise.reject("DISPOSED", "Plugin stopped")
        }
    }

    @ReactMethod fun stopTicker(promise: Promise) {
        synchronized(lock) { ticker?.cancel(false); ticker = null }
        promise.resolve(true)
    }

    override fun invalidate() {
        synchronized(lock) {
            disposed = true; ticker?.cancel(false); ticker = null
            clock.shutdownNow(); work.shutdownNow()
        }
        super.invalidate()
    }

    // ---- Reader and document identity ------------------------------------------------

    /** Path of the document open in the reader, or null. Synchronous host cache; never blocks. */
    @ReactMethod fun currentFile(promise: Promise) = run(promise) {
        HostDataCacheAPI.getInstance()?.currentFilePath?.takeIf { it.isNotBlank() }
    }

    /**
     * KOReader's "binary" document digest (util.partialMD5): MD5 over 1 KiB samples at
     * offsets 0 and 1024 << 2i for i in 0..10. This is what KOReader and CWA call `document`.
     */
    @ReactMethod fun digest(path: String, promise: Promise) = run(promise) {
        val file = File(path)
        require(file.isFile) { "File not found" }
        val md5 = MessageDigest.getInstance("MD5")
        val length = file.length()
        RandomAccessFile(file, "r").use { stream ->
            val buffer = ByteArray(1024)
            for (i in -1..10) {
                val offset = if (i < 0) 0L else 1024L shl (2 * i)
                if (offset >= length) break
                stream.seek(offset)
                var received = 0
                while (received < 1024) {
                    val n = stream.read(buffer, received, 1024 - received)
                    if (n < 0) break
                    received += n
                }
                md5.update(buffer, 0, received)
            }
        }
        Arguments.createMap().apply {
            putString("digest", hex(md5.digest()))
            putDouble("size", length.toDouble())
            putDouble("modified", file.lastModified().toDouble())
        }
    }

    // ---- Settings and credentials -----------------------------------------------------

    @ReactMethod fun settings(promise: Promise) = run(promise) {
        Arguments.createMap().apply {
            putString("url", prefs.getString("url", ""))
            putString("username", prefs.getString("username", ""))
            putBoolean("hasPassword", prefs.contains("password"))
            putString("deviceId", deviceId())
            putString("deviceName", prefs.getString("deviceName", null) ?: defaultDeviceName())
            putBoolean("autoSync", prefs.getBoolean("autoSync", true))
            putBoolean("askBeforeJump", prefs.getBoolean("askBeforeJump", true))
        }
    }

    /** An empty password keeps the stored one, so the settings screen never needs to read it back. */
    @ReactMethod fun saveServer(url: String, username: String, password: String, promise: Promise) = run(promise) {
        require(listOf(url, username, password).none { value -> value.any { it.isISOControl() } }) {
            "Remove line breaks and control characters"
        }
        val origin = URL(url.trim())
        require(origin.protocol == "http" || origin.protocol == "https") { "Use an http:// or https:// address" }
        require(origin.host.isNotBlank() && origin.userInfo == null && origin.query == null && origin.ref == null) {
            "Use a plain server address such as http://192.168.1.10:8083"
        }
        require(username.isNotBlank() && !username.contains(':')) { "Enter your username" }
        val newUrl = url.trim().trimEnd('/')
        val changed = newUrl != prefs.getString("url", null) || username.trim() != prefs.getString("username", null)
        val edit = prefs.edit()
            .putString("url", newUrl)
            .putString("username", username.trim())
        if (changed) edit.remove("rootPath")
        if (password.isNotEmpty()) edit.putString("password", encrypt(password))
        else require(prefs.contains("password") && !changed) {
            // Never send the stored password to a different server or account.
            if (changed) "Enter the password for this server and username" else "Enter your password"
        }
        check(edit.commit()) { "Could not save settings" }
        true
    }

    /** Forgets the server address and credentials (settings and per-book state are kept). */
    @ReactMethod fun clearServer(promise: Promise) = run(promise) {
        check(prefs.edit().remove("url").remove("username").remove("password").remove("rootPath").commit()); true
    }

    /** Stock KOSync servers serve the API at the root; CWA under /kosync (the default for a bare address). */
    @ReactMethod fun setRootPath(root: Boolean, promise: Promise) = run(promise) {
        check(prefs.edit().putBoolean("rootPath", root).commit()); true
    }

    @ReactMethod fun setOption(name: String, value: Boolean, promise: Promise) = run(promise) {
        require(name in listOf("autoSync", "askBeforeJump"))
        check(prefs.edit().putBoolean(name, value).commit()); true
    }

    @ReactMethod fun setDeviceName(name: String, promise: Promise) = run(promise) {
        val trimmed = name.trim()
        require(trimmed.length in 1..60) { "Device name must be 1-60 characters" }
        check(prefs.edit().putString("deviceName", trimmed).commit()); true
    }

    private fun deviceId(): String = synchronized(lock) {
        prefs.getString("deviceId", null) ?: newDeviceId()
    }

    private fun newDeviceId(): String {
        // KOReader uses a random 32-hex identifier per installation.
        val id = hex(ByteArray(16).also { SecureRandom().nextBytes(it) }).uppercase()
        check(prefs.edit().putString("deviceId", id).commit())
        return id
    }

    /** Supernote firmware is shared across models, so the board identifies the device. */
    private fun defaultDeviceName(): String {
        val model = when (Build.BOARD.uppercase(Locale.ROOT).replace(" ", "")) {
            "A5X2" -> "Manta"
            "A6X2" -> "Nomad"
            "A5X" -> "A5 X"
            "A6X" -> "A6 X"
            else -> Build.MODEL.removePrefix("Supernote").trim()
        }
        return "Supernote $model"
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    private fun password(): String {
        val bytes = Base64.decode(prefs.getString("password", null) ?: error("Server not configured"), Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        }
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }

    // ---- HTTP -------------------------------------------------------------------------

    /**
     * Performs one KOSync request against the configured server with HTTP Basic auth
     * (CWA) plus KOReader's x-auth headers (stock kosync servers). Resolves to
     * {status, body}; network failures reject.
     */
    @ReactMethod fun request(method: String, path: String, body: String?, promise: Promise) = run(promise) {
        require(method == "GET" || method == "PUT") { "Unsupported method" }
        require(path.startsWith("/") && !path.contains("..")) { "Invalid path" }
        val base = prefs.getString("url", null) ?: error("Server not configured")
        val user = prefs.getString("username", null) ?: error("Server not configured")
        val pass = password()
        val headers = linkedMapOf(
            "Accept" to "application/vnd.koreader.v1+json",
            "Authorization" to "Basic " + Base64.encodeToString("$user:$pass".toByteArray(Charsets.UTF_8), Base64.NO_WRAP),
            "x-auth-user" to user,
            "x-auth-key" to hex(MessageDigest.getInstance("MD5").digest(pass.toByteArray(Charsets.UTF_8))),
        )
        val payload = body?.toByteArray(Charsets.UTF_8)
        if (payload != null) headers["Content-Type"] = "application/json"
        val target = URL(base + kosyncPrefix(base) + path)
        val (status, text) = if (target.protocol == "https") httpsRequest(target, method, headers, payload)
                             else plainRequest(target, method, headers, payload)
        Arguments.createMap().apply { putInt("status", status); putString("body", text) }
    }

    /** CWA serves KOSync under /kosync; a bare server address gets that prefix. */
    private fun kosyncPrefix(base: String): String {
        val path = URL(base).path.trimEnd('/')
        return if (path.isEmpty() && !prefs.getBoolean("rootPath", false)) "/kosync" else ""
    }

    private fun httpsRequest(url: URL, method: String, headers: Map<String, String>, payload: ByteArray?): Pair<Int, String> {
        val connection = url.openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10000; connection.readTimeout = 30000
            connection.requestMethod = method
            headers.forEach { (k, v) -> connection.setRequestProperty(k, v) }
            if (payload != null) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(payload.size)
                connection.outputStream.use { it.write(payload) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            return status to (stream?.use { readLimited(it) } ?: "")
        } finally { connection.disconnect() }
    }

    /**
     * Plain HTTP/1.1 over a socket. PluginHost targets SDK 35 without a cleartext
     * exemption, so HttpURLConnection refuses http:// even on a home LAN; CWA and
     * KOReader commonly use plain http there.
     */
    private fun plainRequest(url: URL, method: String, headers: Map<String, String>, payload: ByteArray?): Pair<Int, String> {
        val port = if (url.port > 0) url.port else 80
        Socket().use { socket ->
            socket.connect(InetSocketAddress(url.host, port), 10000)
            socket.soTimeout = 30000
            val head = StringBuilder()
            head.append("$method ${url.file.ifEmpty { "/" }} HTTP/1.1\r\n")
            head.append("Host: ${url.host}${if (url.port > 0) ":${url.port}" else ""}\r\n")
            head.append("Connection: close\r\n")
            head.append("User-Agent: SupernoteKOSync\r\n")
            headers.forEach { (k, v) -> head.append("$k: $v\r\n") }
            head.append("Content-Length: ${payload?.size ?: 0}\r\n\r\n")
            val out = socket.getOutputStream()
            out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
            if (payload != null) out.write(payload)
            out.flush()
            val raw = readLimited(socket.getInputStream(), raw = true)
            return parseHttpResponse(raw)
        }
    }

    // ---- Per-book state and diagnostics ----------------------------------------------

    @ReactMethod fun loadState(key: String, promise: Promise) = run(promise) {
        require(key.matches(Regex("[A-Za-z0-9_.-]{1,80}")))
        prefs.getString("state_$key", null)
    }

    @ReactMethod fun saveState(key: String, data: String, promise: Promise) = run(promise) {
        require(key.matches(Regex("[A-Za-z0-9_.-]{1,80}")) && data.length <= 65536)
        check(prefs.edit().putString("state_$key", data).commit()); true
    }

    @ReactMethod fun wifi(promise: Promise) = run(promise) {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) }
        capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true ||
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true
    }

    /** Private log location; PluginHost cannot write to shared storage. Mirrored to logcat (tag KOSync). */
    private fun logFile() = File(context.filesDir, "kosync.log")

    @ReactMethod fun readLog(maxLines: Double, promise: Promise) = run(promise) {
        val file = logFile()
        if (!file.isFile) "" else file.readLines().takeLast(maxLines.toInt().coerceIn(1, 500)).joinToString("\n")
    }

    /** Appends one line to a bounded log that `adb pull` can read for troubleshooting. Never contains credentials. */
    @ReactMethod fun log(line: String) {
        if (disposed) return
        android.util.Log.i("KOSync", line.take(2000))
        try {
            work.execute {
                try {
                    val file = logFile()
                    if (file.length() > 512 * 1024) {
                        val old = File(file.parentFile, "kosync.log.1")
                        old.delete(); file.renameTo(old)
                    }
                    val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date())
                    file.appendText("$stamp ${line.take(2000).replace('\n', ' ')}\n")
                } catch (_: Exception) { }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { }
    }

    /** Reads a small text file the plugin may read (developer harness requests). */
    @ReactMethod fun readTextFile(path: String, promise: Promise) = run(promise) {
        val file = File(path)
        if (file.isFile && file.length() <= 1024 * 1024) file.readText() else null
    }

    /** Removable volumes such as /storage/1234-ABCD (SD cards are outside the plugin path whitelist). */
    @ReactMethod fun storageVolumes(promise: Promise) = run(promise) {
        val names = File("/storage").list()?.filter { it != "emulated" && it != "self" }?.sorted() ?: emptyList()
        Arguments.createArray().apply { names.forEach { pushString("/storage/$it") } }
    }

    /** Developer harness output, collected from logcat by tools/device.py. */
    @ReactMethod fun harnessOut(line: String) {
        android.util.Log.i("KOSyncHarness", line)
    }

    companion object {
        private const val MAX_RESPONSE = 1024 * 1024

        fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

        private fun readLimited(stream: InputStream, raw: Boolean = false): String {
            val bytes = readBytesLimited(stream)
            return if (raw) String(bytes, Charsets.ISO_8859_1) else String(bytes, Charsets.UTF_8)
        }

        private fun readBytesLimited(stream: InputStream): ByteArray {
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val n = stream.read(buffer)
                if (n < 0) break
                out.write(buffer, 0, n)
                require(out.size() <= MAX_RESPONSE) { "Response too large" }
            }
            return out.toByteArray()
        }

        /** Parses a complete HTTP/1.1 response (read until close), handling chunked bodies. */
        fun parseHttpResponse(raw: String): Pair<Int, String> {
            val split = raw.indexOf("\r\n\r\n")
            require(split > 0) { "Malformed HTTP response" }
            val lines = raw.substring(0, split).split("\r\n")
            val status = lines[0].split(" ").getOrNull(1)?.toIntOrNull() ?: error("Malformed HTTP status")
            val headers = lines.drop(1).mapNotNull { line ->
                val i = line.indexOf(':')
                if (i <= 0) null else line.substring(0, i).trim().lowercase(Locale.ROOT) to line.substring(i + 1).trim()
            }.toMap()
            var body = raw.substring(split + 4)
            if (headers["transfer-encoding"]?.lowercase(Locale.ROOT)?.contains("chunked") == true) {
                val decoded = StringBuilder()
                var at = 0
                while (at < body.length) {
                    val eol = body.indexOf("\r\n", at)
                    if (eol < 0) break
                    val size = body.substring(at, eol).substringBefore(';').trim().toInt(16)
                    if (size == 0) break
                    decoded.append(body, eol + 2, eol + 2 + size)
                    at = eol + 2 + size + 2
                }
                body = decoded.toString()
            } else headers["content-length"]?.toIntOrNull()?.let {
                require(it <= body.length) { "Incomplete HTTP response" }
                body = body.substring(0, it)
            }
            // The socket was read as ISO-8859-1 so byte offsets stay exact; restore UTF-8 text.
            return status to String(body.toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8)
        }
    }
}

class KosyncPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(KosyncModule(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
