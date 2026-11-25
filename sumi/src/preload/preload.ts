import { contextBridge, ipcRenderer } from "electron";
import type { ClaudeEvent, ClaudeRequest, Settings, SumiApi } from "../shared/ipc";

const api: SumiApi = {
  fs: {
    readFile: (p) => ipcRenderer.invoke("fs:readFile", p),
    writeFile: (p, text) => ipcRenderer.invoke("fs:writeFile", p, text),
    readDir: (p) => ipcRenderer.invoke("fs:readDir", p),
    stat: (p) => ipcRenderer.invoke("fs:stat", p),
    resolve: (p, base) => ipcRenderer.invoke("fs:resolve", p, base),
    dirname: (p) => ipcRenderer.invoke("fs:dirname", p),
    homeDir: () => ipcRenderer.invoke("fs:homeDir"),
    cwd: () => ipcRenderer.invoke("fs:cwd"),
    sep: () => ipcRenderer.invoke("fs:sep"),
    openDialog: (d) => ipcRenderer.invoke("fs:openDialog", d),
    saveDialog: (d) => ipcRenderer.invoke("fs:saveDialog", d),
  },
  shell: {
    run: (command, cwd, input) => ipcRenderer.invoke("shell:run", command, cwd, input),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke("settings:set", patch),
    setApiKey: (key) => ipcRenderer.invoke("settings:setApiKey", key),
    clearApiKey: () => ipcRenderer.invoke("settings:clearApiKey"),
  },
  claude: {
    stream: (req: ClaudeRequest) => ipcRenderer.invoke("claude:stream", req),
    abort: (id) => ipcRenderer.invoke("claude:abort", id),
    onEvent: (cb) => {
      const listener = (_e: unknown, ev: ClaudeEvent) => cb(ev);
      ipcRenderer.on("claude:event", listener);
      return () => ipcRenderer.removeListener("claude:event", listener);
    },
  },
  app: {
    quit: () => ipcRenderer.send("app:quit"),
    setTitle: (t) => ipcRenderer.send("app:setTitle", t),
    openExternal: (url) => ipcRenderer.send("app:openExternal", url),
    version: () => ipcRenderer.invoke("app:version"),
    args: () => ipcRenderer.invoke("app:args"),
    platform: () => ipcRenderer.invoke("app:platform"),
    isSmoke: () => ipcRenderer.invoke("app:isSmoke"),
  },
};

contextBridge.exposeInMainWorld("sumi", api);
ipcRenderer.on("app:openFiles", (_e, files: string[]) => {
  window.dispatchEvent(new CustomEvent("sumi:openFiles", { detail: files }));
});
