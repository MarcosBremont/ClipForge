let electron = require("electron");
let node_fs = require("node:fs");
let node_fs_promises = require("node:fs/promises");
let node_path = require("node:path");
let node_stream = require("node:stream");
let node_sqlite = require("node:sqlite");
let node_child_process = require("node:child_process");
let node_crypto = require("node:crypto");
let node_stream_promises = require("node:stream/promises");
let electron_updater = require("electron-updater");
// src/shared/types.ts
var DEFAULT_TEXT_STYLE = {
	fontFamily: "Arial",
	fontSize: 76,
	fontWeight: 700,
	color: "#ffffff",
	align: "center",
	x: .5,
	y: .5,
	maxWidth: .86,
	shadow: true,
	shadowBlur: 10,
	shadowColor: "rgba(0,0,0,0.75)",
	outline: true,
	outlineWidth: 6,
	outlineColor: "#000000",
	lineHeight: 1.18,
	uppercase: false,
	startAt: 0,
	endAt: null,
	wholeVideo: true
};
var DEFAULT_GEN_SETTINGS = {
	duration: 15,
	auto: true,
	segmentCount: null,
	segmentLength: null,
	speed: "normal",
	fps: 30,
	quality: "media",
	originalAudio: false,
	musicPath: null,
	musicVolume: .8,
	versions: 1,
	watermark: "",
	useAI: false
};
var VIDEO_EXTENSIONS = [
	".mp4",
	".mov",
	".avi",
	".mkv",
	".webm",
	".m4v",
	".wmv",
	".flv",
	".mpg",
	".mpeg",
	".ts",
	".mts",
	".m2ts",
	".3gp"
];
// src/shared/planner.ts
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = a + 1831565813 >>> 0;
		let t = a;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
var uidCounter = 0;
var uid = () => `s${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
/** Decide cuántos fragmentos y de qué duración según los ajustes. */
function resolveTimings(s, rng) {
	const T = s.duration;
	let n;
	if (s.segmentCount && !s.auto) n = Math.max(1, Math.round(s.segmentCount));
	else {
		let avg;
		if (s.segmentLength && !s.auto) avg = s.segmentLength;
		else if (s.auto) avg = T <= 15 ? 1.3 : T <= 30 ? 1.7 : 2.1;
		else avg = s.speed === "rapido" ? .9 : s.speed === "lento" ? 2.6 : 1.6;
		n = Math.max(2, Math.round(T / Math.max(.4, avg)));
	}
	n = Math.min(n, Math.floor(T / .4));
	const w = Array.from({ length: n }, () => .72 + rng() * .56);
	const sum = w.reduce((a, b) => a + b, 0);
	const d = w.map((x) => Math.max(.4, x / sum * T));
	const fix = T - d.reduce((a, b) => a + b, 0);
	d[d.length - 1] = Math.max(.4, d[d.length - 1] + fix);
	return d.map((x) => Math.round(x * 100) / 100);
}
/** Intervalos de inicio libres [lo,hi] dentro del video para un fragmento de longitud len. */
function freeStarts(v, len, blocked, pad) {
	const maxStart = v.duration - len - .05;
	if (maxStart < 0) return [];
	const forb = blocked.filter((b) => b.videoId === v.id).map((b) => [b.start - len - pad, b.start + b.duration + pad]).sort((x, y) => x[0] - y[0]);
	const out = [];
	let cur = 0;
	for (const [lo, hi] of forb) {
		if (lo > cur) out.push([cur, Math.min(lo, maxStart)]);
		cur = Math.max(cur, hi);
	}
	if (cur <= maxStart) out.push([cur, maxStart]);
	return out.filter(([a, b]) => b - a >= 0 && a <= maxStart);
}
function pickStart(v, len, blocked, rng, pad = .4) {
	const iv = freeStarts(v, len, blocked, pad);
	if (!iv.length) return null;
	const total = iv.reduce((s, [a, b]) => s + (b - a), 0);
	let start;
	if (total <= .001) start = iv[0][0];
	else {
		let r = rng() * total;
		start = iv[0][0];
		for (const [a, b] of iv) {
			if (r <= b - a) {
				start = a + r;
				break;
			}
			r -= b - a;
		}
	}
	if (v.scenes?.length) {
		let best = null;
		let bd = 1.2;
		for (const sc of v.scenes) {
			const d = Math.abs(sc - start);
			if (d < bd && iv.some(([a, b]) => sc >= a && sc <= b)) {
				best = sc;
				bd = d;
			}
		}
		if (best !== null) start = best;
	}
	return Math.max(0, Math.min(start, v.duration - len - .05));
}
function usageCounts(used) {
	const m = /* @__PURE__ */ new Map();
	for (const u of used) m.set(u.videoId, (m.get(u.videoId) ?? 0) + 1);
	return m;
}
function weightedPick(items, weight, rng) {
	const w = items.map(weight);
	const total = w.reduce((a, b) => a + b, 0);
	if (total <= 0) return items[Math.floor(rng() * items.length)];
	let r = rng() * total;
	for (let i = 0; i < items.length; i++) {
		r -= w[i];
		if (r <= 0) return items[i];
	}
	return items[items.length - 1];
}
/** Elige un fragmento (video + inicio) de longitud len evitando solapes y repeticiones. */
function pickSegment(videos, len, blocked, planVideoCount, usage, rng, scores) {
	const fit = videos.filter((v) => v.duration >= len + .1);
	if (!fit.length) return null;
	const weight = (v) => {
		const inPlan = planVideoCount.get(v.id) ?? 0;
		const hist = usage.get(v.id) ?? 0;
		return (.25 + (scores?.get(v.id) ?? .5)) / ((1 + hist * .6) * Math.pow(6, inPlan));
	};
	const pool = [...fit];
	while (pool.length) {
		const v = weightedPick(pool, weight, rng);
		const start = pickStart(v, len, blocked, rng);
		if (start !== null) return {
			video: v,
			start: Math.round(start * 100) / 100
		};
		pool.splice(pool.indexOf(v), 1);
	}
	return null;
}
function makePlan(input) {
	const rng = mulberry32(input.seed);
	const { videos, settings } = input;
	if (!videos.length) throw new Error("La biblioteca no tiene videos utilizables");
	const lens = resolveTimings(settings, rng);
	const usage = usageCounts(input.used);
	const planCount = /* @__PURE__ */ new Map();
	const chosen = [];
	const segments = [];
	for (const len of lens) {
		const tiers = [
			[
				...input.used,
				...input.avoid ?? [],
				...chosen
			],
			[...input.avoid ?? [], ...chosen],
			[...chosen]
		];
		let pick = null;
		for (const blocked of tiers) {
			pick = pickSegment(videos, len, blocked, planCount, usage, rng, input.scores);
			if (pick) break;
		}
		if (!pick) {
			const longest = [...videos].sort((a, b) => b.duration - a.duration)[0];
			const l = Math.max(.3, Math.min(len, longest.duration - .1));
			pick = {
				video: longest,
				start: Math.max(0, Math.round(rng() * (longest.duration - l) * 100) / 100)
			};
			segments.push({
				uid: uid(),
				videoId: pick.video.id,
				start: pick.start,
				duration: Math.round(l * 100) / 100
			});
			chosen.push({
				videoId: pick.video.id,
				start: pick.start,
				duration: l
			});
			continue;
		}
		planCount.set(pick.video.id, (planCount.get(pick.video.id) ?? 0) + 1);
		chosen.push({
			videoId: pick.video.id,
			start: pick.start,
			duration: len
		});
		segments.push({
			uid: uid(),
			videoId: pick.video.id,
			start: pick.start,
			duration: len
		});
	}
	return {
		segments,
		seed: input.seed
	};
}
/** Sustituye un fragmento por otro distinto manteniendo su duración. */
function replaceSegment(plan, index, videos, used, seed, scores) {
	const rng = mulberry32(seed);
	const target = plan.segments[index];
	const others = plan.segments.filter((_, i) => i !== index);
	const blocked = [
		...used,
		...others.map((s) => ({
			videoId: s.videoId,
			start: s.start,
			duration: s.duration
		})),
		{
			videoId: target.videoId,
			start: target.start,
			duration: target.duration
		}
	];
	const planCount = /* @__PURE__ */ new Map();
	for (const s of others) planCount.set(s.videoId, (planCount.get(s.videoId) ?? 0) + 1);
	const pick = pickSegment(videos, target.duration, blocked, planCount, usageCounts(used), rng, scores) ?? pickSegment(videos, target.duration, blocked.slice(used.length), planCount, usageCounts(used), rng, scores);
	if (!pick) return plan;
	const segs = [...plan.segments];
	segs[index] = {
		...target,
		uid: uid(),
		videoId: pick.video.id,
		start: pick.start
	};
	return {
		...plan,
		segments: segs
	};
}
/** Regenera toda la selección con otra semilla. */
function regenerate(input) {
	return makePlan({
		...input,
		seed: input.seed * 1664525 + 1013904223 >>> 0
	});
}
/** Clave estable de una combinación (para registrar y evitar repeticiones). */
function comboKey(segments) {
	const parts = segments.map((s) => `${s.videoId}@${Math.round(s.start * 2) / 2}`).sort().join("|");
	let h1 = 2166136261;
	let h2 = 16777619;
	for (let i = 0; i < parts.length; i++) {
		const c = parts.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
		h2 = Math.imul(h2 + c, 2246822519) >>> 0;
	}
	return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + "-" + segments.length;
}
// src/main/db.ts
var db;
function openDb(dir) {
	db = new node_sqlite.DatabaseSync((0, node_path.join)(dir, "clipforge.db"));
	db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, roots TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      path TEXT NOT NULL, name TEXT NOT NULL, folder TEXT NOT NULL,
      duration REAL NOT NULL, width INTEGER, height INTEGER, fps REAL, codec TEXT, format TEXT,
      size INTEGER NOT NULL, has_audio INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL,
      thumb TEXT, dup_of INTEGER, missing INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
      scenes TEXT,
      UNIQUE(library_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(hash);
    CREATE INDEX IF NOT EXISTS idx_videos_lib ON videos(library_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, library_id INTEGER, data TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outputs (
      id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT NOT NULL, text TEXT NOT NULL,
      duration REAL NOT NULL, size INTEGER NOT NULL, combo TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS used_segments (
      id INTEGER PRIMARY KEY, output_id INTEGER REFERENCES outputs(id) ON DELETE CASCADE,
      video_id INTEGER NOT NULL, start REAL NOT NULL, duration REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_used_video ON used_segments(video_id);
    CREATE TABLE IF NOT EXISTS text_templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, style TEXT NOT NULL);
  `);
	return db;
}
function getSetting(key, fallback) {
	const r = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
	if (!r) return fallback;
	try {
		return JSON.parse(r.value);
	} catch {
		return fallback;
	}
}
function setSetting(key, value) {
	db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}
function listLibraries() {
	return db.prepare(`
    SELECT l.*, COUNT(v.id) AS cnt, COALESCE(SUM(CASE WHEN v.dup_of IS NOT NULL THEN 1 ELSE 0 END),0) AS dups,
           COALESCE(SUM(v.size),0) AS sz, COALESCE(SUM(v.duration),0) AS dur
    FROM libraries l LEFT JOIN videos v ON v.library_id=l.id GROUP BY l.id ORDER BY l.created_at DESC`).all().map((r) => ({
		id: r.id,
		name: r.name,
		roots: JSON.parse(r.roots),
		createdAt: r.created_at,
		videoCount: r.cnt,
		duplicateCount: r.dups,
		totalSize: r.sz,
		totalDuration: r.dur
	}));
}
function createLibrary(name) {
	const r = db.prepare("INSERT INTO libraries(name,roots,created_at) VALUES(?,?,?)").run(name, "[]", Date.now());
	return Number(r.lastInsertRowid);
}
function renameLibrary(id, name) {
	db.prepare("UPDATE libraries SET name=? WHERE id=?").run(name, id);
}
function deleteLibrary(id) {
	db.prepare("DELETE FROM libraries WHERE id=?").run(id);
}
function addLibraryRoot(id, root) {
	const r = db.prepare("SELECT roots FROM libraries WHERE id=?").get(id);
	if (!r) return;
	const roots = JSON.parse(r.roots);
	if (!roots.includes(root)) roots.push(root);
	db.prepare("UPDATE libraries SET roots=? WHERE id=?").run(JSON.stringify(roots), id);
}
function rowToVideo(r) {
	return {
		id: r.id,
		path: r.path,
		name: r.name,
		folder: r.folder,
		duration: r.duration,
		width: r.width,
		height: r.height,
		fps: r.fps,
		codec: r.codec,
		format: r.format,
		size: r.size,
		hasAudio: !!r.has_audio,
		hash: r.hash,
		thumb: r.thumb ?? null,
		dupOf: r.dup_of ?? null,
		missing: !!r.missing,
		libraryId: r.library_id,
		addedAt: r.added_at,
		scenes: r.scenes ? JSON.parse(r.scenes) : null
	};
}
function listVideos(libraryId, opts = {}) {
	const like = `%${(opts.search ?? "").replace(/[%_]/g, "")}%`;
	const total = db.prepare("SELECT COUNT(*) c FROM videos WHERE library_id=? AND name LIKE ?").get(libraryId, like).c;
	return {
		items: db.prepare("SELECT * FROM videos WHERE library_id=? AND name LIKE ? ORDER BY name LIMIT ? OFFSET ?").all(libraryId, like, opts.limit ?? 200, opts.offset ?? 0).map(rowToVideo),
		total
	};
}
/** Videos utilizables para generar: sin duplicados ni archivos perdidos. */
function usableVideos(libraryId) {
	return db.prepare("SELECT * FROM videos WHERE library_id=? AND dup_of IS NULL AND missing=0").all(libraryId).map(rowToVideo);
}
function getVideo(id) {
	const r = db.prepare("SELECT * FROM videos WHERE id=?").get(id);
	return r ? rowToVideo(r) : null;
}
function getVideos(ids) {
	if (!ids.length) return [];
	return db.prepare(`SELECT * FROM videos WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids).map(rowToVideo);
}
function videoExists(libraryId, path) {
	return !!db.prepare("SELECT 1 FROM videos WHERE library_id=? AND path=?").get(libraryId, path);
}
function insertVideo(v) {
	const first = db.prepare("SELECT id FROM videos WHERE library_id=? AND hash=? AND dup_of IS NULL ORDER BY id LIMIT 1").get(v.libraryId, v.hash);
	const r = db.prepare(`INSERT OR IGNORE INTO videos(library_id,path,name,folder,duration,width,height,fps,codec,format,size,has_audio,hash,thumb,dup_of,missing,added_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(v.libraryId, v.path, v.name, v.folder, v.duration, v.width, v.height, v.fps, v.codec, v.format, v.size, v.hasAudio ? 1 : 0, v.hash, v.thumb, first?.id ?? null, Date.now());
	return Number(r.lastInsertRowid);
}
function markMissing(id, missing) {
	db.prepare("UPDATE videos SET missing=? WHERE id=?").run(missing ? 1 : 0, id);
}
function deleteVideo(id) {
	db.prepare("DELETE FROM videos WHERE id=?").run(id);
}
function saveScenes(id, scenes) {
	db.prepare("UPDATE videos SET scenes=? WHERE id=?").run(JSON.stringify(scenes), id);
}
function allVideoPaths(libraryId) {
	return db.prepare("SELECT id,path,missing FROM videos WHERE library_id=?").all(libraryId).map((r) => ({
		id: r.id,
		path: r.path,
		missing: !!r.missing
	}));
}
function countVideos() {
	return db.prepare("SELECT COUNT(*) c FROM videos").get().c;
}
function rowToProject(r) {
	const data = JSON.parse(r.data);
	return {
		id: r.id,
		name: r.name,
		library: r.library_id ?? null,
		text: data.text ?? "",
		style: {
			...DEFAULT_TEXT_STYLE,
			...data.style
		},
		settings: {
			...DEFAULT_GEN_SETTINGS,
			...data.settings
		},
		plan: data.plan ?? null,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}
function listProjects(limit = 100) {
	return db.prepare("SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?").all(limit).map(rowToProject);
}
function getProject(id) {
	const r = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
	return r ? rowToProject(r) : null;
}
function saveProject(p) {
	const data = JSON.stringify({
		text: p.text,
		style: p.style,
		settings: p.settings,
		plan: p.plan
	});
	const now = Date.now();
	if (p.id) {
		db.prepare("UPDATE projects SET name=?, library_id=?, data=?, updated_at=? WHERE id=?").run(p.name, p.library ?? null, data, now, p.id);
		return p.id;
	}
	const r = db.prepare("INSERT INTO projects(name,library_id,data,created_at,updated_at) VALUES(?,?,?,?,?)").run(p.name, p.library ?? null, data, now, now);
	return Number(r.lastInsertRowid);
}
function deleteProject(id) {
	db.prepare("DELETE FROM projects WHERE id=?").run(id);
}
function recordOutput(o) {
	const r = db.prepare("INSERT INTO outputs(project_id,path,text,duration,size,combo,created_at) VALUES(?,?,?,?,?,?,?)").run(o.projectId, o.path, o.text, o.duration, o.size, o.combo, Date.now());
	const id = Number(r.lastInsertRowid);
	const ins = db.prepare("INSERT INTO used_segments(output_id,video_id,start,duration) VALUES(?,?,?,?)");
	for (const s of o.segments) ins.run(id, s.videoId, s.start, s.duration);
	return id;
}
function listOutputs() {
	return db.prepare("SELECT * FROM outputs ORDER BY created_at DESC LIMIT 500").all().map((r) => ({
		id: r.id,
		projectId: r.project_id ?? null,
		path: r.path,
		text: r.text,
		duration: r.duration,
		size: r.size,
		createdAt: r.created_at
	}));
}
function deleteOutput(id) {
	db.prepare("DELETE FROM outputs WHERE id=?").run(id);
}
function countOutputs() {
	return db.prepare("SELECT COUNT(*) c FROM outputs").get().c;
}
function usedSegmentsFor(videoIds) {
	if (!videoIds.length) return [];
	const out = [];
	for (let i = 0; i < videoIds.length; i += 500) {
		const part = videoIds.slice(i, i + 500);
		const rows = db.prepare(`SELECT video_id,start,duration FROM used_segments WHERE video_id IN (${part.map(() => "?").join(",")})`).all(...part);
		for (const r of rows) out.push({
			videoId: r.video_id,
			start: r.start,
			duration: r.duration
		});
	}
	return out;
}
function comboExists(combo) {
	return !!db.prepare("SELECT 1 FROM outputs WHERE combo=?").get(combo);
}
function clearUsageHistory() {
	db.exec("DELETE FROM used_segments");
}
function listTemplates() {
	return db.prepare("SELECT * FROM text_templates ORDER BY id DESC").all().map((r) => ({
		id: r.id,
		name: r.name,
		style: {
			...DEFAULT_TEXT_STYLE,
			...JSON.parse(r.style)
		}
	}));
}
function saveTemplate(name, style) {
	return Number(db.prepare("INSERT INTO text_templates(name,style) VALUES(?,?)").run(name, JSON.stringify(style)).lastInsertRowid);
}
function deleteTemplate(id) {
	db.prepare("DELETE FROM text_templates WHERE id=?").run(id);
}
// src/main/ffmpeg.ts
function unpacked(p) {
	return p.replace("app.asar" + (process.platform === "win32" ? "\\" : "/"), "app.asar.unpacked" + (process.platform === "win32" ? "\\" : "/"));
}
var _ffmpeg = null;
var _ffprobe = null;
function ffmpegPath() {
	if (_ffmpeg) return _ffmpeg;
	if (process.env.CLIPFORGE_FFMPEG) return _ffmpeg = process.env.CLIPFORGE_FFMPEG;
	try {
		const p = unpacked(require("ffmpeg-static"));
		if (p && (0, node_fs.existsSync)(p)) return _ffmpeg = p;
	} catch {}
	return _ffmpeg = "ffmpeg";
}
function ffprobePath() {
	if (_ffprobe) return _ffprobe;
	if (process.env.CLIPFORGE_FFPROBE) return _ffprobe = process.env.CLIPFORGE_FFPROBE;
	try {
		const p = unpacked(require("ffprobe-static").path);
		if (p && (0, node_fs.existsSync)(p)) return _ffprobe = p;
	} catch {}
	return _ffprobe = "ffprobe";
}
function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const p = (0, node_child_process.spawn)(cmd, args, { windowsHide: true });
		opts.onSpawn?.(p);
		let stdout = "";
		let stderr = "";
		p.stdout?.on("data", (d) => {
			stdout += d;
		});
		p.stderr?.on("data", (d) => {
			stderr = (stderr + d).slice(-2e4);
		});
		const timer = opts.timeoutMs ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs) : null;
		p.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		p.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({
				code: code ?? -1,
				stdout,
				stderr
			});
		});
	});
}
async function probe(file) {
	const r = await run(ffprobePath(), [
		"-v",
		"error",
		"-print_format",
		"json",
		"-show_format",
		"-show_streams",
		file
	], { timeoutMs: 6e4 });
	if (r.code !== 0) throw new Error("ffprobe falló: " + r.stderr.trim().split("\n").pop());
	const j = JSON.parse(r.stdout);
	const v = j.streams?.find((s) => s.codec_type === "video" && s.width);
	if (!v) throw new Error("El archivo no contiene video");
	let w = v.width ?? 0;
	let h = v.height ?? 0;
	const rot = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== void 0)?.rotation ?? v.tags?.rotate ?? 0));
	if (rot === 90 || rot === 270) [w, h] = [h, w];
	const [n, d] = (v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate ?? "0/1").split("/").map(Number);
	const fps = d ? n / d : 0;
	const duration = Number(j.format?.duration ?? v.duration ?? 0);
	if (!isFinite(duration) || duration <= 0) throw new Error("Duración no válida");
	return {
		duration,
		width: w,
		height: h,
		fps: Math.round(fps * 100) / 100,
		codec: v.codec_name,
		format: (j.format?.format_name ?? "").split(",")[0],
		hasAudio: !!j.streams?.some((s) => s.codec_type === "audio")
	};
}
async function makeThumbnail(file, out, duration) {
	const t = Math.max(0, Math.min(duration * .25, duration - .1));
	return (await run(ffmpegPath(), [
		"-y",
		"-v",
		"error",
		"-ss",
		t.toFixed(2),
		"-i",
		file,
		"-frames:v",
		"1",
		"-vf",
		"scale=360:-2",
		"-q:v",
		"4",
		out
	], { timeoutMs: 6e4 })).code === 0 && (0, node_fs.existsSync)(out);
}
/** Detecta cambios de escena de forma local con FFmpeg (sin IA). */
async function detectScenes(file, threshold = .32) {
	const r = await run(ffmpegPath(), [
		"-v",
		"info",
		"-i",
		file,
		"-vf",
		`scale=160:-2,select='gt(scene,${threshold})',showinfo`,
		"-an",
		"-f",
		"null",
		"-"
	], { timeoutMs: 6e5 });
	const out = [];
	for (const m of r.stderr.matchAll(/pts_time:([0-9.]+)/g)) out.push(Number(m[1]));
	return out;
}
// src/main/ai.ts
var PROVIDERS = [
	{
		id: "gemini",
		label: "Google Gemini",
		defaultModel: "gemini-2.5-flash",
		kind: "gemini",
		base: "https://generativelanguage.googleapis.com/v1beta"
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		defaultModel: "google/gemini-2.5-flash",
		kind: "openai",
		base: "https://openrouter.ai/api/v1"
	},
	{
		id: "grok",
		label: "Grok (xAI)",
		defaultModel: "grok-4",
		kind: "openai",
		base: "https://api.x.ai/v1"
	},
	{
		id: "qwen",
		label: "Qwen (Alibaba)",
		defaultModel: "qwen-vl-plus",
		kind: "openai",
		base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
	},
	{
		id: "claude",
		label: "Claude (Anthropic)",
		defaultModel: "claude-sonnet-5-5",
		kind: "claude",
		base: "https://api.anthropic.com/v1"
	}
];
var def = (id) => PROVIDERS.find((p) => p.id === id);
function setKey(id, key) {
	if (!key) {
		setSetting(`ai.key.${id}`, null);
		return;
	}
	if (!electron.safeStorage.isEncryptionAvailable()) throw new Error("El sistema no ofrece almacenamiento cifrado de claves; no se guardará la clave.");
	setSetting(`ai.key.${id}`, electron.safeStorage.encryptString(key).toString("base64"));
}
function getKey(id) {
	const v = getSetting(`ai.key.${id}`, null);
	if (!v) return null;
	try {
		return electron.safeStorage.decryptString(Buffer.from(v, "base64"));
	} catch {
		return null;
	}
}
function setModel(id, model) {
	setSetting(`ai.model.${id}`, model || null);
}
function listProviders() {
	const active = getSetting("ai.active", null);
	return PROVIDERS.map((p) => ({
		id: p.id,
		label: p.label,
		defaultModel: p.defaultModel,
		hasKey: !!getSetting(`ai.key.${p.id}`, null),
		model: getSetting(`ai.model.${p.id}`, null) ?? p.defaultModel,
		enabled: active === p.id
	}));
}
function setActive(id) {
	setSetting("ai.active", id);
}
function activeProvider() {
	const a = getSetting("ai.active", null);
	return a && getKey(a) ? a : null;
}
async function http(url, init) {
	const res = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(9e4)
	});
	const text = await res.text();
	if (!res.ok) {
		let msg = text.slice(0, 300);
		try {
			const j = JSON.parse(text);
			msg = j.error?.message ?? j.error ?? j.message ?? msg;
		} catch {}
		throw new Error(`${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
	}
	return JSON.parse(text);
}
async function chat(id, req) {
	const p = def(id);
	const key = getKey(id);
	if (!key) throw new Error(`Falta la API key de ${p.label}`);
	const model = getSetting(`ai.model.${id}`, null) ?? p.defaultModel;
	const imgs = req.imagesB64 ?? [];
	if (p.kind === "gemini") {
		const body = { contents: [{
			role: "user",
			parts: [{ text: req.user }, ...imgs.map((d) => ({ inline_data: {
				mime_type: "image/jpeg",
				data: d
			} }))]
		}] };
		if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
		if (req.json) body.generationConfig = { responseMimeType: "application/json" };
		return (await http(`${p.base}/models/${encodeURIComponent(model)}:generateContent`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": key
			},
			body: JSON.stringify(body)
		})).candidates?.[0]?.content?.parts?.map((x) => x.text ?? "").join("") ?? "";
	}
	if (p.kind === "claude") {
		const content = [...imgs.map((d) => ({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/jpeg",
				data: d
			}
		})), {
			type: "text",
			text: req.user
		}];
		return (await http(`${p.base}/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": key,
				"anthropic-version": "2023-06-01"
			},
			body: JSON.stringify({
				model,
				max_tokens: 1024,
				system: req.system,
				messages: [{
					role: "user",
					content
				}]
			})
		})).content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
	}
	const content = [{
		type: "text",
		text: req.user
	}, ...imgs.map((d) => ({
		type: "image_url",
		image_url: { url: `data:image/jpeg;base64,${d}` }
	}))];
	const messages = [];
	if (req.system) messages.push({
		role: "system",
		content: req.system
	});
	messages.push({
		role: "user",
		content: imgs.length ? content : req.user
	});
	return (await http(`${p.base}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${key}`
		},
		body: JSON.stringify({
			model,
			messages,
			max_tokens: 1024
		})
	})).choices?.[0]?.message?.content ?? "";
}
function extractJson(text) {
	const m = /[[{][\s\S]*[\]}]/.exec(text);
	if (!m) throw new Error("La IA no devolvió JSON válido");
	return JSON.parse(m[0]);
}
async function testProvider(id) {
	return (await chat(id, { user: "Responde únicamente con la palabra: ok" })).trim().slice(0, 80);
}
async function suggestPhrases(id, topic, count = 8) {
	return extractJson(await chat(id, {
		system: "Eres guionista de videos virales cortos (TikTok/Reels/Shorts) en español. Responde solo con un arreglo JSON de strings.",
		user: `Sugiere ${count} frases o preguntas cortas (máx. 12 palabras) que generen curiosidad o debate, para mostrar centradas sobre un video de escenas rápidas.${topic ? ` Tema o contexto: ${topic}.` : ""}`
	})).filter((x) => typeof x === "string").slice(0, count);
}
/** Hoja de contacto de 4 fotogramas para que la IA valore el video. */
async function contactSheet(file, duration, tmp) {
	const times = [
		.15,
		.4,
		.65,
		.9
	].map((f) => Math.max(0, duration * f));
	const out = (0, node_path.join)(tmp, `sheet-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`);
	const args = [
		"-y",
		"-v",
		"error"
	];
	for (const t of times) args.push("-ss", t.toFixed(2), "-i", file);
	args.push("-filter_complex", times.map((_, i) => `[${i}:v]scale=320:-2[s${i}]`).join(";") + ";" + times.map((_, i) => `[s${i}]`).join("") + `hstack=inputs=${times.length}`, "-frames:v", "1", "-q:v", "5", out);
	if ((await run(ffmpegPath(), args, { timeoutMs: 6e4 })).code !== 0) return null;
	try {
		return (0, node_fs.readFileSync)(out).toString("base64");
	} catch {
		return null;
	} finally {
		try {
			(0, node_fs.rmSync)(out, { force: true });
		} catch {}
	}
}
/** Puntúa videos (0..1) según su atractivo visual. Opcional: el editor funciona sin esto. */
async function scoreVideo(id, file, duration, tmpDir) {
	const img = await contactSheet(file, duration, tmpDir);
	if (!img) return null;
	const j = extractJson(await chat(id, {
		system: "Eres editor de videos virales verticales. Responde solo con un objeto JSON {\"score\":0-10,\"note\":\"máx 10 palabras\"}.",
		user: "La imagen muestra 4 fotogramas de un video (de izquierda a derecha, en orden). Puntúa de 0 a 10 qué tan atractivo es visualmente para un video viral de cortes rápidos (acción, emoción, buena composición e iluminación = alto; pantalla negra, texto, borroso o aburrido = bajo).",
		imagesB64: [img]
	}));
	return {
		score: Math.max(0, Math.min(10, Number(j.score))) / 10,
		note: j.note ?? ""
	};
}
// src/main/jobs.ts
var jobs = /* @__PURE__ */ new Map();
var counter = 0;
function newJob(prefix) {
	const id = `${prefix}-${Date.now()}-${++counter}`;
	const ctl = {
		cancelled: false,
		procs: /* @__PURE__ */ new Set()
	};
	jobs.set(id, ctl);
	return {
		id,
		ctl
	};
}
function cancelJob(id) {
	const j = jobs.get(id);
	if (!j) return;
	j.cancelled = true;
	for (const p of j.procs) try {
		p.kill();
	} catch {}
}
function endJob(id) {
	jobs.delete(id);
}
var lastSent = /* @__PURE__ */ new Map();
function emitProgress(p) {
	const now = Date.now();
	if (p.status === "running") {
		if (now - (lastSent.get(p.jobId) ?? 0) < 120) return;
		lastSent.set(p.jobId, now);
	} else lastSent.delete(p.jobId);
	for (const w of electron.BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("job:progress", p);
}
/** Ejecuta tareas con concurrencia limitada. */
async function pool(items, limit, fn, isCancelled) {
	let i = 0;
	const worker = async () => {
		while (i < items.length && !isCancelled()) {
			const idx = i++;
			await fn(items[idx], idx);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
// src/main/library.ts
var EXT = new Set(VIDEO_EXTENSIONS);
function isVideoFile(p) {
	return EXT.has((0, node_path.extname)(p).toLowerCase());
}
async function walk(root, out, isCancelled) {
	let entries;
	try {
		entries = await (0, node_fs_promises.readdir)(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (isCancelled()) return;
		if (e.name.startsWith(".") || e.name === "$RECYCLE.BIN" || e.name === "System Volume Information") continue;
		const full = (0, node_path.join)(root, e.name);
		if (e.isDirectory()) await walk(full, out, isCancelled);
		else if (e.isFile() && isVideoFile(full)) out.push(full);
	}
}
/** Huella rápida: tamaño + 3 bloques del archivo. Evita leer archivos enteros de varios GB. */
async function quickHash(file, size) {
	const h = (0, node_crypto.createHash)("sha1");
	h.update(String(size));
	const fh = await (0, node_fs_promises.open)(file, "r");
	try {
		const CH = 131072;
		const buf = Buffer.alloc(CH);
		const offsets = size <= CH * 3 ? [0] : [
			0,
			Math.floor(size / 2) - CH / 2,
			size - CH
		];
		for (const off of offsets) {
			const { bytesRead } = await fh.read(buf, 0, CH, Math.max(0, off));
			h.update(buf.subarray(0, bytesRead));
		}
	} finally {
		await fh.close();
	}
	return h.digest("hex");
}
/** Importa archivos y/o carpetas (recursivo) a una biblioteca. Corre en segundo plano con progreso. */
function importPaths(libraryId, paths, thumbDir) {
	const { id: jobId, ctl } = newJob("import");
	const label = "Importando videos";
	(async () => {
		const result = {
			added: 0,
			duplicates: 0,
			skipped: 0,
			failed: []
		};
		try {
			emitProgress({
				jobId,
				kind: "import",
				label,
				done: 0,
				total: 0,
				status: "running",
				message: "Buscando videos…"
			});
			const files = [];
			for (const p of paths) {
				let st;
				try {
					st = await (0, node_fs_promises.stat)(p);
				} catch {
					result.failed.push({
						file: p,
						error: "No se puede acceder a la ruta"
					});
					continue;
				}
				if (st.isDirectory()) {
					addLibraryRoot(libraryId, p);
					await walk(p, files, () => ctl.cancelled);
				} else if (isVideoFile(p)) files.push(p);
				else result.failed.push({
					file: p,
					error: "Formato no compatible"
				});
			}
			const todo = [...new Set(files)].filter((f) => {
				if (videoExists(libraryId, f)) {
					result.skipped++;
					return false;
				}
				return true;
			});
			let done = 0;
			(0, node_fs.mkdirSync)(thumbDir, { recursive: true });
			await pool(todo, 4, async (file) => {
				try {
					const st = await (0, node_fs_promises.stat)(file);
					const [info, hash] = await Promise.all([probe(file), quickHash(file, st.size)]);
					const thumb = (0, node_path.join)(thumbDir, `${hash}.jpg`);
					const hasThumb = (0, node_fs.existsSync)(thumb) || await makeThumbnail(file, thumb, info.duration);
					const before = countVideos();
					const id = insertVideo({
						libraryId,
						path: file,
						name: (0, node_path.basename)(file),
						folder: (0, node_path.dirname)(file),
						duration: info.duration,
						width: info.width,
						height: info.height,
						fps: info.fps,
						codec: info.codec,
						format: (0, node_path.extname)(file).slice(1).toLowerCase() || info.format,
						size: st.size,
						hasAudio: info.hasAudio,
						hash,
						thumb: hasThumb ? thumb : null
					});
					if (countVideos() > before) {
						if (getVideo(id)?.dupOf) result.duplicates++;
						result.added++;
					}
				} catch (e) {
					result.failed.push({
						file,
						error: e instanceof Error ? e.message : String(e)
					});
				}
				done++;
				emitProgress({
					jobId,
					kind: "import",
					label,
					done,
					total: todo.length,
					status: "running",
					message: (0, node_path.basename)(file)
				});
			}, () => ctl.cancelled);
			emitProgress({
				jobId,
				kind: "import",
				label,
				done: todo.length,
				total: todo.length,
				status: ctl.cancelled ? "cancelled" : "done",
				result
			});
		} catch (e) {
			emitProgress({
				jobId,
				kind: "import",
				label,
				done: 0,
				total: 0,
				status: "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			endJob(jobId);
		}
	})();
	return jobId;
}
/** Descarga un enlace directo a un video (solo si es accesible y es video) y lo importa. */
function importUrl(libraryId, url, downloadDir, thumbDir) {
	const { id: jobId, ctl } = newJob("import");
	const label = "Descargando video";
	(async () => {
		try {
			const u = new URL(url);
			if (!/^https?:$/.test(u.protocol)) throw new Error("Solo se admiten enlaces http(s)");
			emitProgress({
				jobId,
				kind: "import",
				label,
				done: 0,
				total: 1,
				status: "running",
				message: u.hostname
			});
			const ac = new AbortController();
			const res = await fetch(url, {
				signal: ac.signal,
				redirect: "follow"
			});
			if (!res.ok || !res.body) throw new Error(`El servidor respondió ${res.status}`);
			const type = res.headers.get("content-type") ?? "";
			let name = decodeURIComponent((0, node_path.basename)(new URL(res.url).pathname)) || "video";
			if (!isVideoFile(name)) {
				if (type.startsWith("video/")) name += "." + (type.split("/")[1].split(";")[0].replace("quicktime", "mov") || "mp4");
				else throw new Error("El enlace no apunta directamente a un archivo de video (los enlaces de páginas web o plataformas no son compatibles)");
			}
			(0, node_fs.mkdirSync)(downloadDir, { recursive: true });
			const target = (0, node_path.join)(downloadDir, `${Date.now()}-${name.replace(/[^\w.\- ]/g, "_")}`);
			const total = Number(res.headers.get("content-length") ?? 0);
			let got = 0;
			const src = node_stream.Readable.fromWeb(res.body);
			src.on("data", (c) => {
				got += c.length;
				if (ctl.cancelled) {
					ac.abort();
					src.destroy();
				}
				emitProgress({
					jobId,
					kind: "import",
					label,
					done: got,
					total: total || got,
					status: "running",
					message: name
				});
			});
			await (0, node_stream_promises.pipeline)(src, (0, node_fs.createWriteStream)(target));
			const subId = importPaths(libraryId, [target], thumbDir);
			emitProgress({
				jobId,
				kind: "import",
				label,
				done: 1,
				total: 1,
				status: "done",
				result: {
					subJob: subId,
					added: 0,
					duplicates: 0,
					skipped: 0,
					failed: []
				}
			});
		} catch (e) {
			emitProgress({
				jobId,
				kind: "import",
				label,
				done: 0,
				total: 1,
				status: ctl.cancelled ? "cancelled" : "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			endJob(jobId);
		}
	})();
	return jobId;
}
/** Revisa qué archivos de la biblioteca ya no existen (p. ej. disco externo desconectado). */
async function verifyLibrary(libraryId) {
	let missing = 0;
	let restored = 0;
	for (const v of allVideoPaths(libraryId)) {
		const ok = (0, node_fs.existsSync)(v.path);
		if (!ok && !v.missing) {
			markMissing(v.id, true);
			missing++;
		} else if (ok && v.missing) {
			markMissing(v.id, false);
			restored++;
		} else if (!ok) missing++;
	}
	return {
		missing,
		restored
	};
}
// src/main/render.ts
var OUT_W = 1080;
var OUT_H = 1920;
var encodersCache = null;
async function availableHwEncoders() {
	if (encodersCache) return encodersCache;
	const r = await run(ffmpegPath(), ["-hide_banner", "-encoders"]);
	encodersCache = [
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"h264_videotoolbox"
	].filter((n) => r.stdout.includes(n));
	return encodersCache;
}
function esc(n) {
	return n.toFixed(3);
}
/** Construye el filter_complex. Exportado para pruebas. */
function buildFilter(job) {
	const { segments: segs, settings: s } = job;
	const n = segs.length;
	const total = segs.reduce((a, b) => a + b.duration, 0);
	const keepAudio = s.originalAudio;
	const lines = [];
	for (let i = 0; i < n; i++) {
		lines.push(`[${i}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${s.fps},trim=duration=${esc(segs[i].duration)},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
		if (keepAudio) {
			if (segs[i].hasAudio) lines.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${esc(segs[i].duration)},asetpts=PTS-STARTPTS[a${i}]`);
			else lines.push(`anullsrc=r=48000:cl=stereo:d=${esc(segs[i].duration)},aformat=sample_fmts=fltp[a${i}]`);
		}
	}
	const cat = segs.map((_, i) => `[v${i}]${keepAudio ? `[a${i}]` : ""}`).join("");
	lines.push(`${cat}concat=n=${n}:v=1:a=${keepAudio ? 1 : 0}[vc]${keepAudio ? "[ac]" : ""}`);
	let idx = n;
	let v = "vc";
	const textIdx = job.hasText ? idx++ : -1;
	const wmIdx = job.hasWm ? idx++ : -1;
	const musicIdx = job.hasMusic ? idx++ : -1;
	if (textIdx >= 0) {
		const st = job.style;
		const enable = st.wholeVideo ? "" : `:enable='between(t,${esc(st.startAt)},${esc(st.endAt ?? total)})'`;
		lines.push(`[${v}][${textIdx}:v]overlay=0:0:format=auto${enable}[vt]`);
		v = "vt";
	}
	if (wmIdx >= 0) {
		lines.push(`[${v}][${wmIdx}:v]overlay=0:0:format=auto[vw]`);
		v = "vw";
	}
	let aLabel = keepAudio ? "ac" : null;
	if (musicIdx >= 0) {
		const fadeStart = Math.max(0, total - 1);
		lines.push(`[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${s.musicVolume.toFixed(2)},atrim=0:${esc(total)},afade=t=out:st=${esc(fadeStart)}:d=1,asetpts=PTS-STARTPTS[mu]`);
		if (keepAudio) {
			lines.push(`[ac][mu]amix=inputs=2:duration=first:dropout_transition=0[am]`);
			aLabel = "am";
		} else aLabel = "mu";
	}
	return {
		graph: lines.join(";\n"),
		vLabel: v,
		aLabel,
		textIdx,
		wmIdx,
		musicIdx
	};
}
function encoderArgs(settings, encoder) {
	const crf = settings.quality === "alta" ? 18 : settings.quality === "media" ? 22 : 26;
	const preset = settings.quality === "alta" ? "medium" : settings.quality === "media" ? "fast" : "veryfast";
	switch (encoder) {
		case "h264_nvenc": return [
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p5",
			"-cq",
			String(crf + 2),
			"-b:v",
			"0"
		];
		case "h264_qsv": return [
			"-c:v",
			"h264_qsv",
			"-global_quality",
			String(crf + 2)
		];
		case "h264_amf": return [
			"-c:v",
			"h264_amf",
			"-quality",
			"balanced",
			"-qp_i",
			String(crf + 2),
			"-qp_p",
			String(crf + 2)
		];
		case "h264_videotoolbox": return [
			"-c:v",
			"h264_videotoolbox",
			"-q:v",
			String(settings.quality === "alta" ? 75 : settings.quality === "media" ? 62 : 50)
		];
		default: return [
			"-c:v",
			"libx264",
			"-preset",
			preset,
			"-crf",
			String(crf),
			"-profile:v",
			"high"
		];
	}
}
function runFfmpeg(args, total, job) {
	return new Promise((resolve, reject) => {
		const p = (0, node_child_process.spawn)(ffmpegPath(), args, { windowsHide: true });
		job.onSpawn(p);
		let stderr = "";
		let buf = "";
		p.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split(/\r?\n/);
			buf = lines.pop() ?? "";
			for (const l of lines) {
				const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
				if (m) job.onProgress(Math.min(.99, Number(m[1]) / 1e6 / total));
			}
		});
		p.stderr.on("data", (d) => {
			stderr = (stderr + d.toString()).slice(-8e3);
		});
		p.on("error", reject);
		p.on("close", (code) => resolve({
			code: code ?? -1,
			stderr
		}));
	});
}
async function renderVideo(job, encoder = "libx264") {
	const { segments, settings } = job;
	if (!segments.length) throw new Error("No hay fragmentos para exportar");
	(0, node_fs.mkdirSync)(job.tmpDir, { recursive: true });
	const total = segments.reduce((a, b) => a + b.duration, 0);
	const textPath = job.textPng ? (0, node_path.join)(job.tmpDir, "text.png") : null;
	const wmPath = job.watermarkPng ? (0, node_path.join)(job.tmpDir, "wm.png") : null;
	if (textPath) (0, node_fs.writeFileSync)(textPath, job.textPng);
	if (wmPath) (0, node_fs.writeFileSync)(wmPath, job.watermarkPng);
	const hasMusic = !!settings.musicPath && (0, node_fs.existsSync)(settings.musicPath);
	const f = buildFilter({
		segments,
		settings,
		style: job.style,
		hasText: !!textPath,
		hasWm: !!wmPath,
		hasMusic
	});
	const scriptPath = (0, node_path.join)(job.tmpDir, "graph.txt");
	(0, node_fs.writeFileSync)(scriptPath, f.graph);
	const args = [
		"-y",
		"-hide_banner",
		"-v",
		"error",
		"-nostdin",
		"-progress",
		"pipe:1",
		"-nostats"
	];
	for (const s of segments) args.push("-ss", esc(s.start), "-t", esc(s.duration + .05), "-i", s.path);
	if (textPath) args.push("-loop", "1", "-framerate", String(settings.fps), "-t", esc(total), "-i", textPath);
	if (wmPath) args.push("-loop", "1", "-framerate", String(settings.fps), "-t", esc(total), "-i", wmPath);
	if (hasMusic) args.push("-stream_loop", "-1", "-i", settings.musicPath);
	args.push("-filter_complex_script", scriptPath, "-map", `[${f.vLabel}]`);
	if (f.aLabel) args.push("-map", `[${f.aLabel}]`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000");
	else args.push("-an");
	args.push(...encoderArgs(settings, encoder), "-pix_fmt", "yuv420p", "-r", String(settings.fps), "-t", esc(total), "-movflags", "+faststart");
	const tmpOut = job.outPath + ".part.mp4";
	args.push(tmpOut);
	try {
		const r = await runFfmpeg(args, total, job);
		if (job.isCancelled()) throw new Error("Cancelado");
		if (r.code !== 0) {
			if (encoder !== "libx264") return renderVideo(job, "libx264");
			throw new Error("FFmpeg falló: " + (r.stderr.trim().split("\n").slice(-3).join(" ") || `código ${r.code}`));
		}
		(0, node_fs.renameSync)(tmpOut, job.outPath);
		job.onProgress(1);
		return {
			size: (0, node_fs.statSync)(job.outPath).size,
			duration: total
		};
	} finally {
		for (const p of [
			tmpOut,
			textPath,
			wmPath,
			scriptPath
		]) if (p) try {
			(0, node_fs.rmSync)(p, { force: true });
		} catch {}
	}
}
/** Proxy ligero para previsualizar formatos que Chromium no reproduce (MKV, AVI, HEVC…). */
async function makeProxy(v, outDir) {
	(0, node_fs.mkdirSync)(outDir, { recursive: true });
	const out = (0, node_path.join)(outDir, `${v.hash}.mp4`);
	if ((0, node_fs.existsSync)(out)) return out;
	const tmp = out + ".part.mp4";
	const r = await run(ffmpegPath(), [
		"-y",
		"-v",
		"error",
		"-i",
		v.path,
		"-vf",
		"scale=-2:540,fps=30",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-crf",
		"28",
		"-g",
		"15",
		"-c:a",
		"aac",
		"-b:a",
		"96k",
		"-movflags",
		"+faststart",
		tmp
	], { timeoutMs: 18e5 });
	if (r.code !== 0) throw new Error("No se pudo crear el proxy: " + r.stderr.trim().split("\n").pop());
	(0, node_fs.renameSync)(tmp, out);
	return out;
}
// src/main/updater.ts
var state = { status: "idle" };
var silent = false;
function set(s) {
	state = s;
	for (const w of electron.BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update:state", s);
}
var getState = () => state;
var friendly = (e) => {
	const m = e instanceof Error ? e.message : String(e);
	if (/404|Not Found|latest\.yml|Cannot find/i.test(m)) return "No se encontró ninguna versión publicada todavía (revisa que el repositorio de actualizaciones y el release existan y sean públicos).";
	if (/ENOTFOUND|ECONN|ETIMEDOUT|network|net::/i.test(m)) return "No hay conexión con el servidor de actualizaciones.";
	return m.split("\n")[0].slice(0, 220);
};
function initUpdater() {
	electron_updater.autoUpdater.logger = console;
	electron_updater.autoUpdater.autoDownload = false;
	electron_updater.autoUpdater.autoInstallOnAppQuit = true;
	electron_updater.autoUpdater.allowPrerelease = false;
	const feed = process.env.CLIPFORGE_UPDATE_URL;
	if (feed) {
		electron_updater.autoUpdater.forceDevUpdateConfig = true;
		electron_updater.autoUpdater.setFeedURL({
			provider: "generic",
			url: feed
		});
	}
	electron_updater.autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
	electron_updater.autoUpdater.on("update-not-available", () => set({ status: "none" }));
	electron_updater.autoUpdater.on("update-available", (i) => {
		const notes = typeof i.releaseNotes === "string" ? i.releaseNotes.replace(/<[^>]+>/g, "").trim() : "";
		set({
			status: "available",
			version: i.version,
			notes
		});
	});
	electron_updater.autoUpdater.on("download-progress", (p) => set({
		status: "downloading",
		percent: Math.round(p.percent)
	}));
	electron_updater.autoUpdater.on("update-downloaded", (i) => set({
		status: "ready",
		version: i.version
	}));
	electron_updater.autoUpdater.on("error", (e) => {
		if (silent) {
			silent = false;
			set({ status: "idle" });
			return;
		}
		set({
			status: "error",
			message: friendly(e)
		});
	});
}
function canUpdate() {
	return electron.app.isPackaged || !!process.env.CLIPFORGE_UPDATE_URL;
}
async function checkForUpdates(isSilent = false) {
	if (!canUpdate()) {
		set({
			status: "unavailable",
			message: "Las actualizaciones solo funcionan en la versión instalada, no en modo desarrollo."
		});
		return state;
	}
	silent = isSilent;
	try {
		await electron_updater.autoUpdater.checkForUpdates();
	} catch (e) {
		if (!isSilent) set({
			status: "error",
			message: friendly(e)
		});
	}
	silent = false;
	return state;
}
async function downloadUpdate() {
	try {
		set({
			status: "downloading",
			percent: 0
		});
		await electron_updater.autoUpdater.downloadUpdate();
	} catch (e) {
		set({
			status: "error",
			message: friendly(e)
		});
	}
}
function installUpdate() {
	electron_updater.autoUpdater.quitAndInstall(false, true);
}
// src/main/index.ts
electron.protocol.registerSchemesAsPrivileged([{
	scheme: "media",
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		stream: true,
		bypassCSP: true
	}
}]);
var testDir = process.env.CLIPFORGE_E2E ?? process.env.CLIPFORGE_E2E_PLAYBACK ?? process.env.CLIPFORGE_E2E_UPDATE;
if (testDir) electron.app.setPath("userData", (0, node_path.join)(testDir, "userdata"));
var win = null;
var dir = (n) => {
	const p = (0, node_path.join)(electron.app.getPath("userData"), n);
	(0, node_fs.mkdirSync)(p, { recursive: true });
	return p;
};
function defaultOutputDir() {
	return (0, node_path.join)(electron.app.getPath("videos"), "ClipForge");
}
function getAppSettings() {
	return {
		outputDir: getSetting("outputDir", defaultOutputDir()),
		activeProvider: activeProvider(),
		hwAccel: getSetting("hwAccel", false)
	};
}
var MIME = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".ogg": "audio/ogg",
	".flac": "audio/flac"
};
/** Sirve archivos locales con soporte real de peticiones Range (imprescindible para saltar dentro de videos grandes). */
async function mediaHandler(req) {
	const p = decodeURIComponent(new URL(req.url).pathname.slice(1));
	let size;
	try {
		size = (await (0, node_fs_promises.stat)(p)).size;
	} catch {
		return new Response("No encontrado", { status: 404 });
	}
	const base = {
		"Content-Type": MIME[(0, node_path.extname)(p).toLowerCase()] ?? "application/octet-stream",
		"Accept-Ranges": "bytes"
	};
	const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
	if (!m || !m[1] && !m[2]) return new Response(node_stream.Readable.toWeb((0, node_fs.createReadStream)(p)), {
		status: 200,
		headers: {
			...base,
			"Content-Length": String(size)
		}
	});
	let start = m[1] ? Number(m[1]) : 0;
	let end = m[2] ? Number(m[2]) : size - 1;
	if (!m[1]) {
		start = Math.max(0, size - Number(m[2]));
		end = size - 1;
	}
	end = Math.min(end, size - 1);
	if (start > end || start >= size) return new Response(null, {
		status: 416,
		headers: { "Content-Range": `bytes */${size}` }
	});
	return new Response(node_stream.Readable.toWeb((0, node_fs.createReadStream)(p, {
		start,
		end
	})), {
		status: 206,
		headers: {
			...base,
			"Content-Range": `bytes ${start}-${end}/${size}`,
			"Content-Length": String(end - start + 1)
		}
	});
}
function createWindow() {
	win = new electron.BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 1100,
		minHeight: 700,
		backgroundColor: "#0e0f13",
		autoHideMenuBar: true,
		title: "ClipForge",
		webPreferences: {
			preload: (0, node_path.join)(__dirname, "../preload/index.js"),
			sandbox: false,
			contextIsolation: true
		}
	});
	if (process.env["ELECTRON_RENDERER_URL"]) win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
	else win.loadFile((0, node_path.join)(__dirname, "../renderer/index.html"));
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
function historyRanges(videoIds) {
	return usedSegmentsFor(videoIds);
}
function loadScores(libraryId) {
	const o = getSetting(`ai.scores.${libraryId}`, null);
	if (!o) return void 0;
	return new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
}
var slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).toLowerCase() || "video";
function startRender(req) {
	const { id: jobId, ctl } = newJob("render");
	const label = "Generando video";
	const versions = Math.max(1, Math.min(100, req.settings.versions));
	(async () => {
		const outputs = [];
		const errors = [];
		try {
			const outDir = getAppSettings().outputDir;
			(0, node_fs.mkdirSync)(outDir, { recursive: true });
			const videos = usableVideos(req.libraryId);
			const used = historyRanges(videos.map((v) => v.id));
			const avoid = [];
			const scores = req.settings.useAI ? loadScores(req.libraryId) : void 0;
			const hw = getAppSettings().hwAccel ? (await availableHwEncoders())[0] : void 0;
			for (let v = 1; v <= versions && !ctl.cancelled; v++) {
				const msg = versions > 1 ? `Versión ${v} de ${versions}` : "Renderizando";
				const base = (v - 1) / versions;
				emitProgress({
					jobId,
					kind: "render",
					label,
					done: Math.round(base * 1e3),
					total: 1e3,
					status: "running",
					message: msg
				});
				try {
					let plan = v === 1 ? req.plan : null;
					if (!plan) {
						let seed = Date.now() + v * 7919 >>> 0;
						for (let attempt = 0; attempt < 6; attempt++) {
							plan = makePlan({
								videos,
								settings: req.settings,
								used,
								avoid,
								seed,
								scores
							});
							if (!comboExists(comboKey(plan.segments))) break;
							seed = seed * 1664525 + 1013904223 >>> 0;
						}
					}
					if (!plan) throw new Error("No se pudo generar la selección");
					const byId = new Map(getVideos([...new Set(plan.segments.map((s) => s.videoId))]).map((x) => [x.id, x]));
					const segs = plan.segments.map((s) => {
						const vid = byId.get(s.videoId);
						if (!vid) throw new Error("Un fragmento usa un video que ya no está en la biblioteca");
						if (!(0, node_fs.existsSync)(vid.path)) throw new Error(`No se encuentra el archivo: ${vid.name}`);
						return {
							path: vid.path,
							start: s.start,
							duration: s.duration,
							hasAudio: vid.hasAudio
						};
					});
					const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
					const outPath = (0, node_path.join)(outDir, `${slug(req.text)}_${stamp}_v${v}.mp4`);
					const tmpDir = (0, node_path.join)(dir("tmp"), `${jobId}-${v}`);
					const r = await renderVideo({
						segments: segs,
						settings: req.settings,
						style: req.style,
						textPng: req.textPng ? Buffer.from(req.textPng) : null,
						watermarkPng: req.watermarkPng ? Buffer.from(req.watermarkPng) : null,
						outPath,
						tmpDir,
						onProgress: (f) => emitProgress({
							jobId,
							kind: "render",
							label,
							done: Math.round((base + f / versions) * 1e3),
							total: 1e3,
							status: "running",
							message: msg
						}),
						onSpawn: (p) => {
							ctl.procs.add(p);
							p.on("close", () => ctl.procs.delete(p));
						},
						isCancelled: () => ctl.cancelled
					}, hw);
					(0, node_fs.rmSync)(tmpDir, {
						recursive: true,
						force: true
					});
					const rec = plan.segments.map((s) => ({
						videoId: s.videoId,
						start: s.start,
						duration: s.duration
					}));
					const outId = recordOutput({
						projectId: req.projectId,
						path: outPath,
						text: req.text,
						duration: r.duration,
						size: r.size,
						combo: comboKey(plan.segments),
						segments: rec
					});
					avoid.push(...rec);
					outputs.push({
						path: outPath,
						id: outId
					});
				} catch (e) {
					if (ctl.cancelled) break;
					errors.push(`Versión ${v}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			const status = ctl.cancelled ? "cancelled" : outputs.length === 0 ? "error" : "done";
			emitProgress({
				jobId,
				kind: "render",
				label,
				done: 1e3,
				total: 1e3,
				status,
				message: errors.join("\n") || void 0,
				result: {
					outputs,
					errors
				}
			});
		} catch (e) {
			emitProgress({
				jobId,
				kind: "render",
				label,
				done: 0,
				total: 1e3,
				status: "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			endJob(jobId);
		}
	})();
	return jobId;
}
function analyzeScenes(libraryId) {
	const { id: jobId, ctl } = newJob("analyze");
	const label = "Detectando cambios de escena";
	(async () => {
		try {
			const vids = usableVideos(libraryId).filter((v) => !v.scenes);
			let done = 0;
			await pool(vids, 2, async (v) => {
				try {
					saveScenes(v.id, await detectScenes(v.path));
				} catch {}
				done++;
				emitProgress({
					jobId,
					kind: "analyze",
					label,
					done,
					total: vids.length,
					status: "running",
					message: v.name
				});
			}, () => ctl.cancelled);
			emitProgress({
				jobId,
				kind: "analyze",
				label,
				done: vids.length,
				total: vids.length,
				status: ctl.cancelled ? "cancelled" : "done"
			});
		} catch (e) {
			emitProgress({
				jobId,
				kind: "analyze",
				label,
				done: 0,
				total: 0,
				status: "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			endJob(jobId);
		}
	})();
	return jobId;
}
function analyzeWithAI(libraryId, limit) {
	const { id: jobId, ctl } = newJob("analyze");
	const label = "Analizando videos con IA";
	(async () => {
		try {
			const prov = activeProvider();
			if (!prov) throw new Error("Configura y activa un proveedor de IA en el apartado Inteligencia artificial");
			const scores = getSetting(`ai.scores.${libraryId}`, {});
			const vids = usableVideos(libraryId).filter((v) => scores[v.id] === void 0).slice(0, limit);
			const tmp = dir("tmp");
			let done = 0;
			let fails = 0;
			let lastErr = "";
			await pool(vids, 3, async (v) => {
				try {
					const r = await scoreVideo(prov, v.path, v.duration, tmp);
					if (r) scores[v.id] = r.score;
				} catch (e) {
					fails++;
					lastErr = e instanceof Error ? e.message : String(e);
					if (fails >= 3 && done === 0) ctl.cancelled = true;
				}
				done++;
				emitProgress({
					jobId,
					kind: "analyze",
					label,
					done,
					total: vids.length,
					status: "running",
					message: v.name
				});
			}, () => ctl.cancelled);
			setSetting(`ai.scores.${libraryId}`, scores);
			emitProgress({
				jobId,
				kind: "analyze",
				label,
				done: vids.length,
				total: vids.length,
				status: fails && done <= fails ? "error" : ctl.cancelled ? "cancelled" : "done",
				message: fails ? `${fails} fallos. Último: ${lastErr}` : void 0
			});
		} catch (e) {
			emitProgress({
				jobId,
				kind: "analyze",
				label,
				done: 0,
				total: 0,
				status: "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			endJob(jobId);
		}
	})();
	return jobId;
}
function registerIpc() {
	const h = (ch, fn) => {
		electron.ipcMain.handle(ch, async (_e, ...args) => fn(...args));
	};
	h("app:version", () => electron.app.getVersion());
	h("update:state", () => getState());
	h("update:check", () => checkForUpdates(false));
	h("update:download", () => downloadUpdate());
	h("update:install", () => installUpdate());
	h("app:settings", () => getAppSettings());
	h("app:setOutputDir", (d) => {
		setSetting("outputDir", d);
	});
	h("app:setHwAccel", (v) => {
		setSetting("hwAccel", v);
	});
	h("app:hwEncoders", () => availableHwEncoders());
	h("app:stats", () => ({
		videos: countVideos(),
		libraries: listLibraries().length,
		generated: countOutputs(),
		recentProjects: listProjects(5)
	}));
	h("dialog:folder", async () => {
		const r = await electron.dialog.showOpenDialog(win, { properties: ["openDirectory", "multiSelections"] });
		return r.canceled ? [] : r.filePaths;
	});
	h("dialog:videos", async () => {
		const r = await electron.dialog.showOpenDialog(win, {
			properties: ["openFile", "multiSelections"],
			filters: [{
				name: "Videos",
				extensions: VIDEO_EXTENSIONS.map((e) => e.slice(1))
			}]
		});
		return r.canceled ? [] : r.filePaths;
	});
	h("dialog:music", async () => {
		const r = await electron.dialog.showOpenDialog(win, {
			properties: ["openFile"],
			filters: [{
				name: "Audio",
				extensions: [
					"mp3",
					"wav",
					"m4a",
					"aac",
					"ogg",
					"flac"
				]
			}]
		});
		return r.canceled ? null : r.filePaths[0];
	});
	h("dialog:outputDir", async () => {
		const r = await electron.dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
		return r.canceled ? null : r.filePaths[0];
	});
	h("lib:list", () => listLibraries());
	h("lib:create", (name) => createLibrary(name));
	h("lib:rename", (id, name) => renameLibrary(id, name));
	h("lib:delete", (id) => deleteLibrary(id));
	h("lib:videos", (id, opts) => listVideos(id, opts));
	h("lib:import", (id, paths) => importPaths(id, paths, dir("thumbs")));
	h("lib:importUrl", (id, url) => importUrl(id, url, dir("downloads"), dir("thumbs")));
	h("lib:verify", (id) => verifyLibrary(id));
	h("lib:removeVideo", (id) => deleteVideo(id));
	h("lib:analyzeScenes", (id) => analyzeScenes(id));
	h("lib:analyzeAI", (id, limit) => analyzeWithAI(id, limit));
	h("video:getMany", (ids) => getVideos(ids));
	h("video:proxy", async (id) => {
		const v = getVideo(id);
		if (!v) throw new Error("Video no encontrado");
		return makeProxy(v, dir("proxies"));
	});
	const planInput = (libraryId, settings, extraAvoid = []) => {
		const videos = usableVideos(libraryId);
		return {
			videos,
			settings: {
				...DEFAULT_GEN_SETTINGS,
				...settings
			},
			used: historyRanges(videos.map((v) => v.id)),
			avoid: extraAvoid,
			scores: settings.useAI ? loadScores(libraryId) : void 0
		};
	};
	h("plan:make", (libraryId, settings) => makePlan({
		...planInput(libraryId, settings),
		seed: Date.now() & 2147483647
	}));
	h("plan:regen", (libraryId, settings, prev) => regenerate({
		...planInput(libraryId, settings, prev?.segments.map((s) => ({
			videoId: s.videoId,
			start: s.start,
			duration: s.duration
		})) ?? []),
		seed: prev?.seed ?? Date.now() & 2147483647
	}));
	h("plan:replace", (libraryId, settings, plan, index) => {
		const i = planInput(libraryId, settings);
		return replaceSegment(plan, index, i.videos, i.used, Date.now() & 2147483647, i.scores);
	});
	h("plan:pick", (libraryId, settings, plan, videoId, index) => {
		const v = getVideo(videoId);
		if (!v) return plan;
		const len = index !== null ? plan.segments[index].duration : Math.min(1.5, Math.max(.5, v.duration - .2));
		const start = Math.max(0, Math.round(Math.random() * Math.max(0, v.duration - len - .1) * 100) / 100);
		const seg = {
			uid: `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
			videoId,
			start,
			duration: Math.round(len * 100) / 100
		};
		const segs = [...plan.segments];
		if (index !== null) segs[index] = seg;
		else segs.push(seg);
		return {
			...plan,
			segments: segs
		};
	});
	h("render:start", (req) => startRender(req));
	h("job:cancel", (id) => cancelJob(id));
	h("project:list", () => listProjects());
	h("project:get", (id) => getProject(id));
	h("project:save", (p) => saveProject(p));
	h("project:delete", (id) => deleteProject(id));
	h("output:list", () => listOutputs().map((o) => ({
		...o,
		exists: (0, node_fs.existsSync)(o.path)
	})));
	h("output:delete", (id, removeFile) => {
		const o = listOutputs().find((x) => x.id === id);
		if (o && removeFile) try {
			(0, node_fs.rmSync)(o.path, { force: true });
		} catch {}
		deleteOutput(id);
	});
	h("output:reveal", (p) => {
		electron.shell.showItemInFolder(p);
	});
	h("output:open", (p) => electron.shell.openPath(p));
	h("history:clear", () => clearUsageHistory());
	h("template:list", () => listTemplates());
	h("template:save", (name, style) => saveTemplate(name, style));
	h("template:delete", (id) => deleteTemplate(id));
	h("ai:providers", () => listProviders());
	h("ai:setKey", (id, key) => setKey(id, key));
	h("ai:setModel", (id, m) => setModel(id, m));
	h("ai:setActive", (id) => setActive(id));
	h("ai:test", async (id) => testProvider(id));
	h("ai:suggest", async (topic) => {
		const p = activeProvider();
		if (!p) throw new Error("Activa un proveedor de IA en el apartado Inteligencia artificial");
		return suggestPhrases(p, topic);
	});
	h("file:exists", (p) => (0, node_fs.existsSync)(p));
	h("file:size", (p) => {
		try {
			return (0, node_fs.statSync)(p).size;
		} catch {
			return 0;
		}
	});
}
electron.app.whenReady().then(() => {
	openDb(electron.app.getPath("userData"));
	electron.protocol.handle("media", mediaHandler);
	electron.session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "local-fonts"));
	electron.session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "local-fonts");
	registerIpc();
	createWindow();
	initUpdater();
	if (!process.env.CLIPFORGE_E2E && !process.env.CLIPFORGE_E2E_PLAYBACK && !process.env.CLIPFORGE_E2E_UPDATE && canUpdate()) setTimeout(() => void checkForUpdates(true), 8e3);
	const upd = process.env.CLIPFORGE_E2E_UPDATE;
	if (upd && win) {
		const w = win;
		Promise.resolve().then(() => require("./e2e-update-CY_QHZN5.js")).then((m) => m.runUpdateE2E(w, upd));
	}
	const diag = process.env.CLIPFORGE_E2E_PLAYBACK;
	if (diag && win) {
		const w = win;
		Promise.resolve().then(() => require("./e2e-playback-DRwGkHd_.js")).then((m) => m.runPlaybackDiag(w, diag));
	}
	const e2e = process.env.CLIPFORGE_E2E;
	if (e2e && win) {
		const w = win;
		Promise.resolve().then(() => require("./e2e-CNBzplvz.js")).then((m) => m.runE2E(w, e2e));
	}
	electron.app.on("activate", () => {
		if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});
electron.app.on("window-all-closed", () => {
	if (process.platform !== "darwin") electron.app.quit();
});
exports.checkForUpdates = checkForUpdates;
exports.downloadUpdate = downloadUpdate;
exports.ffmpegPath = ffmpegPath;
exports.getState = getState;
exports.probe = probe;
exports.run = run;
