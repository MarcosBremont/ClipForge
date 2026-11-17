let electron = require("electron");
// src/preload/index.ts
var call = (ch, ...a) => electron.ipcRenderer.invoke(ch, ...a);
var api = {
	invoke: call,
	pathForFile: (f) => electron.webUtils.getPathForFile(f),
	onUpdate: (cb) => {
		const fn = (_, s) => cb(s);
		electron.ipcRenderer.on("update:state", fn);
		return () => electron.ipcRenderer.removeListener("update:state", fn);
	},
	onJob: (cb) => {
		const fn = (_, p) => cb(p);
		electron.ipcRenderer.on("job:progress", fn);
		return () => electron.ipcRenderer.removeListener("job:progress", fn);
	}
};
electron.contextBridge.exposeInMainWorld("api", api);
