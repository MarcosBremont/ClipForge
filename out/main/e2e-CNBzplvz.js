const require_index = require("./index.js");
let electron = require("electron");
let node_fs = require("node:fs");
let node_path = require("node:path");
// src/main/e2e.ts
async function runE2E(win, work) {
	const log = [];
	const errors = [];
	const say = (s) => {
		log.push(s);
		console.log("[e2e]", s);
	};
	win.webContents.on("console-message", (e) => {
		if (e.level === "error") errors.push(e.message);
	});
	const js = (code) => win.webContents.executeJavaScript(code);
	const shot = async (name) => {
		const img = await win.webContents.capturePage();
		(0, node_fs.writeFileSync)((0, node_path.join)(work, name + ".png"), img.toPNG());
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const waitJob = (id) => js(`new Promise(res => { const off = window.api.onJob(p => { if (p.jobId === ${JSON.stringify(id)} && p.status !== 'running') { off(); res(p) } }) })`);
	let failed = 0;
	const check = (name, cond, extra = "") => {
		say(`${cond ? "OK  " : "FAIL"} ${name} ${extra}`);
		if (!cond) failed++;
	};
	try {
		await sleep(1500);
		const src = (0, node_path.join)(work, "src");
		const nested = (0, node_path.join)(src, "sub", "deep");
		(0, node_fs.mkdirSync)(nested, { recursive: true });
		const gen = async (file, spec, sec, audio) => {
			const args = [
				"-y",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				`${spec}:rate=30`
			];
			if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=${300 + sec * 40}`, "-c:a", "aac");
			args.push("-t", String(sec), "-c:v", "libx264", "-pix_fmt", "yuv420p", file);
			const r = await require_index.run(require_index.ffmpegPath(), args);
			if (r.code) throw new Error(r.stderr);
		};
		const specs = [
			"testsrc=size=1280x720",
			"testsrc2=size=1920x1080",
			"smptebars=size=720x1280",
			"mandelbrot=size=640x360",
			"life=size=800x800",
			"rgbtestsrc=size=1280x720"
		];
		for (let i = 0; i < specs.length; i++) await gen((0, node_path.join)(i % 2 ? nested : src, `clip${i}${i === 3 ? ".mkv" : ".mp4"}`), specs[i], 6 + i, i % 2 === 0);
		(0, node_fs.copyFileSync)((0, node_path.join)(src, "clip0.mp4"), (0, node_path.join)(src, "copy_of_clip0.mp4"));
		(0, node_fs.writeFileSync)((0, node_path.join)(src, "notes.txt"), "no es video");
		await js(`window.api.invoke('app:setOutputDir', ${JSON.stringify((0, node_path.join)(work, "out"))})`);
		const libId = await js(`window.api.invoke('lib:create','E2E')`);
		const imp = await waitJob(await js(`window.api.invoke('lib:import', ${libId}, [${JSON.stringify(src)}])`));
		const ir = imp.result;
		check("importación recursiva termina", imp.status === "done");
		check("importa 7 archivos (6 + copia)", ir.added === 7, `added=${ir.added}`);
		check("detecta 1 duplicado", ir.duplicates === 1, `dups=${ir.duplicates}`);
		const libs = await js(`window.api.invoke('lib:list')`);
		check("biblioteca refleja conteos", libs[0].videoCount === 7 && libs[0].duplicateCount === 1);
		check("todas con miniatura", (await js(`window.api.invoke('lib:videos', ${libId}, {})`)).items.every((v) => v.thumb));
		await waitJob(await js(`window.api.invoke('lib:import', ${libId}, [${JSON.stringify(src)}])`));
		check("reimportar no duplica registros", (await js(`window.api.invoke('lib:list')`))[0].videoCount === 7);
		const settings = {
			duration: 10,
			auto: true,
			segmentCount: null,
			segmentLength: null,
			speed: "normal",
			fps: 30,
			quality: "rapida",
			originalAudio: true,
			musicPath: null,
			musicVolume: .8,
			versions: 3,
			watermark: "@miusuario",
			useAI: false
		};
		const plan = await js(`window.api.invoke('plan:make', ${libId}, ${JSON.stringify(settings)})`);
		check("plan generado con suma 10 s", Math.abs(plan.segments.reduce((a, s) => a + s.duration, 0) - 10) < .06, `n=${plan.segments.length}`);
		await js(`(async () => { const s = window.__clipforge.store; s.getState().setDraft({ libraryId: ${libId}, text: '¿Será que soy un mal hombre?', settings: ${JSON.stringify(settings)}, plan: ${JSON.stringify(plan)} }); s.getState().go('crear') })()`);
		await sleep(3500);
		await shot("crear");
		const vstate = await js(`JSON.stringify([...document.querySelectorAll('.phone video')].map(v => ({ src: !!v.src, ready: v.readyState, err: v.error && v.error.code })))`);
		check("reproductor carga fuentes de video", /"src":true/.test(vstate), vstate);
		await js(`[...document.querySelectorAll('button')].find(b => /Play/.test(b.textContent)).click()`);
		await sleep(1800);
		const adv = await js(`document.querySelectorAll('.phone video')[0].currentTime + document.querySelectorAll('.phone video')[1].currentTime`);
		check("al pulsar play los videos avanzan", adv > .1, `t=${adv.toFixed(2)}`);
		await shot("crear-play");
		for (const p of [
			"inicio",
			"biblioteca",
			"plantillas",
			"ia",
			"config"
		]) {
			await js(`window.__clipforge.store.getState().go('${p}')`);
			await sleep(700);
			await shot(p);
		}
		const png = await js(`(async () => { const st = window.__clipforge.store.getState().draft.style; return Array.from(await window.__clipforge.textOverlayPng('¿Será que soy un mal hombre?', st)) })()`);
		const wm = await js(`(async () => Array.from(await window.__clipforge.watermarkPng('@miusuario')))()`);
		const style = await js(`window.__clipforge.store.getState().draft.style`);
		const rr = await waitJob(await js(`window.api.invoke('render:start', { projectId: null, libraryId: ${libId}, text: '¿Será que soy un mal hombre?', style: ${JSON.stringify(style)}, settings: ${JSON.stringify(settings)}, textPng: new Uint8Array(${JSON.stringify(png)}), watermarkPng: new Uint8Array(${JSON.stringify(wm)}), plan: ${JSON.stringify(plan)} })`));
		const outs = rr.result.outputs;
		check("lote de 3 versiones renderizado", rr.status === "done" && outs.length === 3, `${outs.length} salidas ${rr.message ?? ""}`);
		for (const o of outs) {
			const pi = await require_index.probe(o.path);
			check(`salida válida ${o.path.split(/[\\/]/).pop()}`, pi.width === 1080 && pi.height === 1920 && pi.codec === "h264" && pi.hasAudio && Math.abs(pi.duration - 10) < .2, `${pi.width}x${pi.height} ${pi.duration.toFixed(2)}s`);
		}
		check("salidas registradas en la base de datos", (await js(`window.api.invoke('output:list')`)).length === 3);
		check("segundo plan generado tras historial", (await js(`window.api.invoke('plan:make', ${libId}, ${JSON.stringify(settings)})`)).segments.length > 1);
		await js(`window.__clipforge.store.getState().go('generados')`);
		await sleep(900);
		await shot("generados");
		const pj = await js(`window.api.invoke('project:get', ${await js(`window.api.invoke('project:save', { name: 'E2E', library: ${libId}, text: 'hola', plan: ${JSON.stringify(plan)} })`)})`);
		check("proyecto se guarda y recupera con su plan", pj.text === "hola" && pj.plan.segments.length === plan.segments.length);
	} catch (e) {
		say("EXCEPCION " + (e instanceof Error ? e.stack : String(e)));
		failed++;
	}
	if (errors.length) say("Errores de consola: " + errors.join(" | "));
	check("sin errores de consola en la interfaz", errors.length === 0);
	(0, node_fs.writeFileSync)((0, node_path.join)(work, "e2e.log"), log.join("\n"));
	electron.app.exit(failed ? 1 : 0);
}
exports.runE2E = runE2E;
