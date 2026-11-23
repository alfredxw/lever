package dev.mygo

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import org.json.JSONObject

// One mobile binary can pair with different self-hosted Firebase projects.
// FCM may start the Android process while no Activity or Go WebView exists.
private fun configure(context: Context, json: JSONObject) {
    val options = FirebaseOptions.Builder()
        .setProjectId(json.getString("projectId"))
        .setApplicationId(json.getString("appId"))
        .setApiKey(json.getString("apiKey"))
        .setGcmSenderId(json.getString("senderId"))
        .build()
    val current = FirebaseApp.getApps(context).find { it.name == FirebaseApp.DEFAULT_APP_NAME }
    if (current?.options == options) return
    current?.delete()
    FirebaseApp.initializeApp(context, options)
}

private fun store(context: Context) = context.getSharedPreferences("lever-firebase", Context.MODE_PRIVATE)

class LeverMobile : MyGoPlugin {
    private val handler = Handler(Looper.getMainLooper())
    private var multicast: WifiManager.MulticastLock? = null
    private val release = Runnable { multicast?.let { if (it.isHeld) it.release() } }

    // Some Wi-Fi drivers discard mDNS packets unless the app holds this lock.
    // The Go lookup lasts 1.2s. Bound the lock on the native side even if the caller cancels.
    private fun allowDiscovery(context: Context) {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = multicast ?: wifi.createMulticastLock("lever-discovery").also {
            it.setReferenceCounted(false)
            multicast = it
        }
        if (!lock.isHeld) lock.acquire()
        handler.removeCallbacks(release)
        handler.postDelayed(release, 2000)
    }

    override fun call(method: String, args: JSONObject, reply: PluginReply) {
        val context = PluginHost.context
        runCatching {
            when (method) {
                "allowDiscovery" -> allowDiscovery(context)
                "configureFirebase" -> {
                    configure(context, args)
                    check(store(context).edit().putString("options", args.toString()).commit())
                }
                else -> return reply.failure(PluginFailure("NoMethod", method))
            }
        }.onSuccess { reply.success(null) }
            .onFailure { reply.failure(PluginFailure("Unavailable", "Could not complete " + method)) }
    }
}

class LeverFirebaseInit : ContentProvider() {
    override fun onCreate(): Boolean {
        val app = context ?: return false
        store(app).getString("options", null)?.let { runCatching { configure(app, JSONObject(it)) } }
        return true
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
}
