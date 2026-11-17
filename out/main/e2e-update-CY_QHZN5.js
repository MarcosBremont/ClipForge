const require_index = require("./index.js");
let electron = require("electron");
let node_fs = require("node:fs");
let node_path = require("node:path");
// src/main/e2e-update.ts
async function runUpdateE2E(win, work) {
	const out = [];
	const say = (s) => {
		out.push(s);
		console.log("[upd]", s);
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const waitFor = async (st, ms = 9e4) => {
		for (let t = 0; t < ms; t += 200) {
			if (require_index.getState().status === st) return true;
			if (require_index.getState().status === "error") return false;
			await sleep(200);
		}
		return false;
	};
	const seen = [];
	win.webContents.on("ipc-message", () => void 0);
	try {
		await sleep(1500);
		say("versión instalada: " + electron.app.getVersion());
		require_index.checkForUpdates(false);
		const found = await waitFor("available");
		const s = require_index.getState();
		say(`OK   encuentra actualización: ${found} ${JSON.stringify(s)}`);
		if (!found) throw new Error("no se encontró: " + JSON.stringify(s));
		require_index.downloadUpdate();
		const ready = await waitFor("ready");
		say(`OK   descarga y verifica sha512: ${ready} ${JSON.stringify(require_index.getState())}`);
		seen.push(String(ready));
		if (!ready) throw new Error("descarga falló");
	} catch (e) {
		say("FAIL " + (e instanceof Error ? e.message : String(e)));
	}
	(0, node_fs.writeFileSync)((0, node_path.join)(work, "update.log"), out.join("\n"));
	electron.app.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
}
exports.runUpdateE2E = runUpdateE2E;
