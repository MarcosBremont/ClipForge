package com.clipforge.android.planner

import com.clipforge.android.model.GenSettings
import com.clipforge.android.model.Plan
import com.clipforge.android.model.Segment
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

// Motor de selección de fragmentos. Lógica pura (sin Android) portada de src/shared/planner.ts para poder probarla en la JVM.

data class Range(val videoId: Long, val start: Double, val duration: Double)

/** Lo que el planificador necesita saber de un video. */
data class PVideo(val id: Long, val duration: Double)

fun mulberry32(seed: Long): () -> Double {
    var a = seed.toInt()
    return {
        a += 0x6d2b79f5
        var t = a
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
    }
}

private var uidCounter = 0
private fun uid(): String = "s" + System.currentTimeMillis().toString(36) + (uidCounter++).toString(36) + (Math.random() * 1e4).toInt().toString(36)
private fun r2(x: Double): Double = Math.floor(x * 100 + 0.5) / 100

/** Decide cuántos fragmentos y de qué duración según los ajustes; la suma es exactamente la duración pedida. */
fun resolveTimings(s: GenSettings, rng: () -> Double): List<Double> {
    val total = s.duration.toDouble()
    var n: Int
    if (s.segmentCount != null && !s.auto) n = max(1, s.segmentCount)
    else {
        val avg = if (s.segmentLength != null && !s.auto) s.segmentLength
        else if (s.auto) (if (total <= 15) 1.3 else if (total <= 30) 1.7 else 2.1)
        else when (s.speed) { "rapido" -> 0.9; "lento" -> 2.6; else -> 1.6 }
        n = max(2, Math.floor(total / max(0.4, avg) + 0.5).toInt())
    }
    n = min(n, Math.floor(total / 0.4).toInt())
    val w = List(n) { 0.72 + rng() * 0.56 }
    val sum = w.sum()
    val d = w.map { max(0.4, it / sum * total) }.toMutableList()
    val fix = total - d.sum()
    d[d.size - 1] = max(0.4, d[d.size - 1] + fix)
    return d.map { r2(it) }
}

private fun freeStarts(v: PVideo, len: Double, blocked: List<Range>, pad: Double): List<Pair<Double, Double>> {
    val maxStart = v.duration - len - 0.05
    if (maxStart < 0) return emptyList()
    val forb = blocked.filter { it.videoId == v.id }
        .map { (it.start - len - pad) to (it.start + it.duration + pad) }
        .sortedBy { it.first }
    val out = mutableListOf<Pair<Double, Double>>()
    var cur = 0.0
    for ((lo, hi) in forb) {
        if (lo > cur) out.add(cur to min(lo, maxStart))
        cur = max(cur, hi)
    }
    if (cur <= maxStart) out.add(cur to maxStart)
    return out.filter { (a, b) -> b - a >= 0 && a <= maxStart }
}

private fun pickStart(v: PVideo, len: Double, blocked: List<Range>, rng: () -> Double, pad: Double = 0.4): Double? {
    val iv = freeStarts(v, len, blocked, pad)
    if (iv.isEmpty()) return null
    val total = iv.sumOf { it.second - it.first }
    var start: Double
    if (total <= 0.001) start = iv[0].first
    else {
        var r = rng() * total
        start = iv[0].first
        for ((a, b) in iv) {
            if (r <= b - a) { start = a + r; break }
            r -= b - a
        }
    }
    return max(0.0, min(start, v.duration - len - 0.05))
}

data class PlanInput(
    val videos: List<PVideo>,
    val settings: GenSettings,
    val used: List<Range>,
    val avoid: List<Range> = emptyList(),
    val seed: Long,
    val scores: Map<Long, Double>? = null
)

private fun usageCounts(used: List<Range>): Map<Long, Int> {
    val m = HashMap<Long, Int>()
    for (u in used) m[u.videoId] = (m[u.videoId] ?: 0) + 1
    return m
}

private fun <T> weightedPick(items: List<T>, weight: (T) -> Double, rng: () -> Double): T {
    val w = items.map(weight)
    val total = w.sum()
    if (total <= 0) return items[Math.floor(rng() * items.size).toInt()]
    var r = rng() * total
    for (i in items.indices) { r -= w[i]; if (r <= 0) return items[i] }
    return items.last()
}

data class Pick(val video: PVideo, val start: Double)

fun pickSegment(
    videos: List<PVideo>, len: Double, blocked: List<Range>, planCount: Map<Long, Int>,
    usage: Map<Long, Int>, rng: () -> Double, scores: Map<Long, Double>? = null
): Pick? {
    val fit = videos.filter { it.duration >= len + 0.1 }
    if (fit.isEmpty()) return null
    val weight = { v: PVideo ->
        val inPlan = planCount[v.id] ?: 0
        val hist = usage[v.id] ?: 0
        val score = scores?.get(v.id) ?: 0.5
        (0.25 + score) / ((1 + hist * 0.6) * 6.0.pow(inPlan))
    }
    val pool = fit.toMutableList()
    while (pool.isNotEmpty()) {
        val v = weightedPick(pool, weight, rng)
        val start = pickStart(v, len, blocked, rng)
        if (start != null) return Pick(v, r2(start))
        pool.remove(v)
    }
    return null
}

fun makePlan(input: PlanInput): Plan {
    val rng = mulberry32(input.seed)
    val videos = input.videos
    require(videos.isNotEmpty()) { "La biblioteca no tiene videos utilizables" }
    val lens = resolveTimings(input.settings, rng)
    val usage = usageCounts(input.used)
    val planCount = HashMap<Long, Int>()
    val chosen = mutableListOf<Range>()
    val segments = mutableListOf<Segment>()
    for (len in lens) {
        // 1.º evitar historial + lote + plan actual; 2.º solo lote y plan; 3.º solo plan actual.
        val tiers = listOf(input.used + input.avoid + chosen, input.avoid + chosen, chosen.toList())
        var pick: Pick? = null
        for (blocked in tiers) {
            pick = pickSegment(videos, len, blocked, planCount, usage, rng, input.scores)
            if (pick != null) break
        }
        if (pick == null) {
            // Ningún video es lo bastante largo: acorta usando el más largo disponible.
            val longest = videos.maxByOrNull { it.duration }!!
            val l = max(0.3, min(len, longest.duration - 0.1))
            val start = max(0.0, r2(rng() * (longest.duration - l)))
            segments.add(Segment(uid(), longest.id, start, r2(l)))
            chosen.add(Range(longest.id, start, l))
            continue
        }
        planCount[pick.video.id] = (planCount[pick.video.id] ?: 0) + 1
        chosen.add(Range(pick.video.id, pick.start, len))
        segments.add(Segment(uid(), pick.video.id, pick.start, len))
    }
    return Plan(segments, input.seed)
}

/** Sustituye un fragmento por otro distinto manteniendo su duración. */
fun replaceSegment(plan: Plan, index: Int, videos: List<PVideo>, used: List<Range>, seed: Long, scores: Map<Long, Double>? = null): Plan {
    val rng = mulberry32(seed)
    val target = plan.segments[index]
    val others = plan.segments.filterIndexed { i, _ -> i != index }
    val blocked = used + others.map { Range(it.videoId, it.start, it.duration) } + Range(target.videoId, target.start, target.duration)
    val planCount = HashMap<Long, Int>()
    for (s in others) planCount[s.videoId] = (planCount[s.videoId] ?: 0) + 1
    val pick = pickSegment(videos, target.duration, blocked, planCount, usageCounts(used), rng, scores)
        ?: pickSegment(videos, target.duration, blocked.drop(used.size), planCount, usageCounts(used), rng, scores)
        ?: return plan
    val segs = plan.segments.toMutableList()
    segs[index] = target.copy(uid = uid(), videoId = pick.video.id, start = pick.start)
    return plan.copy(segments = segs)
}

/** Añade un fragmento nuevo (de la duración dada) al final del plan. */
fun addSegment(plan: Plan, duration: Double, videos: List<PVideo>, used: List<Range>, seed: Long): Plan {
    val rng = mulberry32(seed)
    val own = plan.segments.map { Range(it.videoId, it.start, it.duration) }
    val planCount = HashMap<Long, Int>()
    for (s in plan.segments) planCount[s.videoId] = (planCount[s.videoId] ?: 0) + 1
    val pick = pickSegment(videos, duration, used + own, planCount, usageCounts(used), rng)
        ?: pickSegment(videos, duration, own, planCount, usageCounts(used), rng)
        ?: return plan
    return plan.copy(segments = plan.segments + Segment(uid(), pick.video.id, pick.start, duration))
}

fun regenerate(input: PlanInput): Plan = makePlan(input.copy(seed = (input.seed * 1664525L + 1013904223L) and 0xFFFFFFFFL))

/** Clave estable de una combinación (para registrar y evitar repeticiones). */
fun comboKey(segments: List<Segment>): String {
    val parts = segments.map { "${it.videoId}@${Math.floor(it.start * 2 + 0.5) / 2}" }.sorted().joinToString("|")
    var h1 = 0x811c9dc5.toInt()
    var h2 = 0x01000193
    for (ch in parts) {
        val c = ch.code
        h1 = (h1 xor c) * 16777619
        h2 = (h2 + c) * -2048144777 // 2246822519 como Int con signo
    }
    return Integer.toHexString(h1).padStart(8, '0') + Integer.toHexString(h2).padStart(8, '0') + "-" + segments.size
}

fun totalDuration(segments: List<Segment>): Double = r2(segments.sumOf { it.duration })
