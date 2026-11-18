package com.clipforge.android.ai

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.util.Base64
import com.clipforge.android.Services
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

enum class Kind { OPENAI, GEMINI, CLAUDE }

data class Provider(val id: String, val label: String, val defaultModel: String, val kind: Kind, val base: String)

val PROVIDERS = listOf(
    Provider("gemini", "Google Gemini", "gemini-2.5-flash", Kind.GEMINI, "https://generativelanguage.googleapis.com/v1beta"),
    Provider("openrouter", "OpenRouter", "google/gemini-2.5-flash", Kind.OPENAI, "https://openrouter.ai/api/v1"),
    Provider("grok", "Grok (xAI)", "grok-4", Kind.OPENAI, "https://api.x.ai/v1"),
    Provider("qwen", "Qwen (Alibaba)", "qwen-vl-plus", Kind.OPENAI, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    Provider("claude", "Claude (Anthropic)", "claude-sonnet-5-5", Kind.CLAUDE, "https://api.anthropic.com/v1")
)

class AiException(msg: String) : Exception(msg)

/** IA opcional. Las claves se guardan cifradas (Keystore) y nunca están en el código. La app funciona igual sin ellas. */
class AiClient(private val svc: Services) {
    fun provider(id: String) = PROVIDERS.first { it.id == id }
    fun hasKey(id: String) = !key(id).isNullOrBlank()
    private fun key(id: String): String? = svc.secrets?.getString("key.$id", null)
    fun secureStorageAvailable() = svc.secrets != null

    fun setKey(id: String, key: String) {
        val s = svc.secrets ?: throw AiException("Este teléfono no permite guardar claves de forma cifrada.")
        s.edit().apply { if (key.isBlank()) remove("key.$id") else putString("key.$id", key.trim()) }.apply()
    }

    fun model(id: String): String = svc.prefs.getString("ai.model.$id", null)?.takeIf { it.isNotBlank() } ?: provider(id).defaultModel
    fun setModel(id: String, model: String) { svc.prefs.edit().putString("ai.model.$id", model.trim()).apply() }
    fun active(): String? = svc.prefs.getString("ai.active", null)?.takeIf { hasKey(it) }
    fun setActive(id: String?) { svc.prefs.edit().putString("ai.active", id).apply() }

    suspend fun chat(id: String, prompt: String, imagesB64: List<String> = emptyList(), maxTokens: Int = 700): String = withContext(Dispatchers.IO) {
        val p = provider(id)
        val key = key(id) ?: throw AiException("Falta la clave de ${p.label}.")
        val model = model(id)
        when (p.kind) {
            Kind.GEMINI -> {
                val parts = JSONArray().put(JSONObject().put("text", prompt))
                imagesB64.forEach { parts.put(JSONObject().put("inline_data", JSONObject().put("mime_type", "image/jpeg").put("data", it))) }
                val body = JSONObject().put("contents", JSONArray().put(JSONObject().put("parts", parts)))
                    .put("generationConfig", JSONObject().put("maxOutputTokens", maxTokens))
                val r = post("${p.base}/models/$model:generateContent", mapOf("x-goog-api-key" to key), body)
                r.getJSONArray("candidates").getJSONObject(0).getJSONObject("content").getJSONArray("parts").getJSONObject(0).getString("text")
            }
            Kind.OPENAI -> {
                val content = JSONArray().put(JSONObject().put("type", "text").put("text", prompt))
                imagesB64.forEach { content.put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", "data:image/jpeg;base64,$it"))) }
                val body = JSONObject().put("model", model).put("max_tokens", maxTokens)
                    .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
                val r = post("${p.base}/chat/completions", mapOf("Authorization" to "Bearer $key"), body)
                r.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content")
            }
            Kind.CLAUDE -> {
                val content = JSONArray()
                imagesB64.forEach { content.put(JSONObject().put("type", "image").put("source", JSONObject().put("type", "base64").put("media_type", "image/jpeg").put("data", it))) }
                content.put(JSONObject().put("type", "text").put("text", prompt))
                val body = JSONObject().put("model", model).put("max_tokens", maxTokens)
                    .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
                val r = post("${p.base}/messages", mapOf("x-api-key" to key, "anthropic-version" to "2023-06-01"), body)
                r.getJSONArray("content").getJSONObject(0).getString("text")
            }
        }
    }

    suspend fun test(id: String): String = chat(id, "Responde solo con la palabra OK.", maxTokens = 20).trim().take(60)

    suspend fun suggestPhrases(id: String, topic: String, count: Int = 8): List<String> {
        val prompt = "Eres guionista de videos virales cortos (TikTok/Reels/Shorts). Escribe $count frases o preguntas MUY cortas " +
            "(máximo 9 palabras), en español, que enganchen, sobre: \"${topic.ifBlank { "curiosidades y entretenimiento" }}\". " +
            "Devuelve solo una frase por línea, sin numeración ni comillas."
        return chat(id, prompt, maxTokens = 400).lines().map { it.trim().trimStart('-', '•', '*', ' ').trim('"') }.filter { it.length > 3 }.take(count)
    }

    /** Valora de 0 a 1 un video a partir de una hoja de contacto de sus fotogramas (nunca se sube el video). */
    suspend fun scoreVideo(id: String, frames: List<Bitmap>): Double? {
        if (frames.isEmpty()) return null
        val sheet = contactSheet(frames)
        val prompt = "Estos 4 fotogramas pertenecen a un video. Puntúa de 0 a 10 qué tan atractivo y dinámico es para un video vertical viral " +
            "(nitidez, acción, interés visual). Responde SOLO con JSON: {\"score\":N}"
        val out = chat(id, prompt, listOf(sheet), 60)
        val n = Regex("\"score\"\\s*:\\s*([0-9.]+)").find(out)?.groupValues?.get(1)?.toDoubleOrNull() ?: return null
        return (n / 10.0).coerceIn(0.0, 1.0)
    }

    private fun contactSheet(frames: List<Bitmap>): String {
        val cw = 360; val ch = 640
        val bmp = Bitmap.createBitmap(cw * 2, ch * 2, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        frames.take(4).forEachIndexed { i, f -> c.drawBitmap(f, null, Rect((i % 2) * cw, (i / 2) * ch, (i % 2 + 1) * cw, (i / 2 + 1) * ch), null) }
        val bos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 70, bos)
        bmp.recycle()
        return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
    }

    private fun post(url: String, headers: Map<String, String>, body: JSONObject): JSONObject {
        val con = URL(url).openConnection() as HttpURLConnection
        try {
            con.requestMethod = "POST"; con.connectTimeout = 15000; con.readTimeout = 60000; con.doOutput = true
            con.setRequestProperty("Content-Type", "application/json")
            headers.forEach { (k, v) -> con.setRequestProperty(k, v) }
            con.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = con.responseCode
            val text = (if (code in 200..299) con.inputStream else con.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw AiException(when (code) {
                401, 403 -> "La clave fue rechazada ($code). Revisa que sea correcta y tenga permisos."
                404 -> "Modelo no encontrado (404). Cambia el nombre del modelo."
                429 -> "Límite de uso o saldo agotado (429)."
                else -> "Error $code: ${text.take(160)}"
            })
            return JSONObject(text)
        } catch (e: AiException) { throw e }
        catch (e: java.io.IOException) { throw AiException("Sin conexión con el proveedor.") }
        catch (e: org.json.JSONException) { throw AiException("Respuesta inesperada del proveedor.") }
        finally { con.disconnect() }
    }
}
