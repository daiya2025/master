import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FileEntry, ReadDirResult, ReadFileResult, ShellResult, WriteFileResult } from "../shared/ipc";
import { clearApiKey, getSettings, setApiKey, updateSettings } from "./settings";
import { abortAll, abortStream, startStream } from "./claude";
import { runSmoke } from "./smoke";

const isSmoke = process.argv.includes("--smoke");
// The smoke test must not touch the real settings file (it flips themes, etc.).
if (isSmoke) app.setPath("userData", path.join(os.tmpdir(), `sumi-smoke-${process.pid}`));
const fileArgs = process.argv
  .slice(app.isPackaged ? 1 : 2)
  .filter((a) => !a.startsWith("--") && !a.startsWith("-"))
  .map((a) => path.resolve(a));

let win: BrowserWindow | null = null;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function statEntry(p: string): Promise<FileEntry | null> {
  try {
    const st = await fs.stat(p);
    return { name: path.basename(p), path: p, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function createWindow(): void {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 320,
    title: "Sumi",
    backgroundColor: "#1e1f26",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.on("closed", () => (win = null));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (isSmoke) {
    win.webContents.once("did-finish-load", () => {
      void runSmoke(win!);
    });
  }
}

function registerIpc(): void {
  ipcMain.handle("fs:readFile", async (_e, p: string): Promise<ReadFileResult> => {
    try {
      const st = await fs.stat(p);
      if (st.isDirectory()) return { ok: false, error: "is a directory", notFound: false, isDirectory: true, path: p };
      const text = await fs.readFile(p, "utf8");
      return { ok: true, text, path: p };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { ok: false, error: e.message, notFound: e.code === "ENOENT", isDirectory: false, path: p };
    }
  });
  ipcMain.handle("fs:writeFile", async (_e, p: string, text: string): Promise<WriteFileResult> => {
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, text, "utf8");
      return { ok: true, path: p };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("fs:readDir", async (_e, p: string): Promise<ReadDirResult> => {
    try {
      const names = await fs.readdir(p);
      const entries = (await Promise.all(names.map((n) => statEntry(path.join(p, n))))).filter(
        (e): e is FileEntry => e !== null,
      );
      entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      return { ok: true, path: p, entries };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("fs:stat", (_e, p: string) => statEntry(p));
  ipcMain.handle("fs:resolve", (_e, p: string, base?: string) => path.resolve(base ?? process.cwd(), expandHome(p)));
  ipcMain.handle("fs:dirname", (_e, p: string) => path.dirname(p));
  ipcMain.handle("fs:homeDir", () => os.homedir());
  ipcMain.handle("fs:cwd", () => process.cwd());
  ipcMain.handle("fs:sep", () => path.sep);
  ipcMain.handle("fs:openDialog", async (_e, defaultPath?: string) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ["openFile"] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle("fs:saveDialog", async (_e, defaultPath?: string) => {
    if (!win) return null;
    const r = await dialog.showSaveDialog(win, { defaultPath });
    return r.canceled || !r.filePath ? null : r.filePath;
  });

  ipcMain.handle("shell:run", (_e, command: string, cwd: string | null, input?: string): Promise<ShellResult> => {
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: cwd ?? undefined, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 120_000);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: null, error: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
  });

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, patch) => updateSettings(patch));
  ipcMain.handle("settings:setApiKey", async (_e, key: string) => {
    try {
      await setApiKey(key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("settings:clearApiKey", () => clearApiKey());

  ipcMain.handle("claude:stream", (e, req) => startStream(e.sender, req));
  ipcMain.handle("claude:abort", (_e, id: string) => abortStream(id));

  ipcMain.on("app:quit", () => app.quit());
  ipcMain.on("app:setTitle", (_e, title: string) => win?.setTitle(title));
  ipcMain.on("app:openExternal", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:args", () => fileArgs);
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("app:isSmoke", () => isSmoke);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isSmoke) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const extra = argv.slice(1).filter((a) => !a.startsWith("-")).map((a) => path.resolve(a));
    if (win) {
      win.focus();
      if (extra.length) win.webContents.send("app:openFiles", extra);
    }
  });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    abortAll();
    app.quit();
  });
}
