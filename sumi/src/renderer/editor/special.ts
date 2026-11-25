import { EditorSelection } from "@codemirror/state";
import type { Buffer } from "./buffer";
import { Editor, UserError, ensureSep } from "./editor";
import { Keymap } from "./keys";

function lineAtPoint(ed: Editor): number {
  const st = ed.view.state;
  return st.doc.lineAt(st.selection.main.head).number;
}

function gotoLineOf(ed: Editor, b: Buffer, n: number): void {
  const win = ed.windows.find((w) => w.buffer === b);
  if (!win) return;
  const doc = win.view.state.doc;
  const line = doc.line(Math.max(1, Math.min(doc.lines, n)));
  win.view.dispatch({ selection: EditorSelection.cursor(line.from) });
}

// ---------------------------------------------------------------- *Buffer List*

const bufferListKeymap = new Keymap("buffer-list", {
  RET: "buffer-list-select",
  f: "buffer-list-select",
  o: "buffer-list-select-other-window",
  k: "buffer-list-kill",
  d: "buffer-list-kill",
  g: "list-buffers",
  q: "quit-window",
  n: "next-line",
  p: "previous-line",
});

export function renderBufferList(ed: Editor): Buffer {
  const b = ed.getBufferCreate("*Buffer List*", "special");
  b.readOnly = true;
  b.localKeymap = bufferListKeymap;
  b.modeName = "Buffer Menu";
  const rows = ed.buffers.filter((x) => x !== b);
  const nameW = Math.max(12, ...rows.map((x) => x.name.length));
  const modeW = Math.max(6, ...rows.map((x) => x.modeName.length));
  const lines = [
    ` CRM ${"Buffer".padEnd(nameW)}  ${"Size".padStart(8)}  ${"Mode".padEnd(modeW)}  File`,
    ` --- ${"------".padEnd(nameW)}  ${"----".padStart(8)}  ${"----".padEnd(modeW)}  ----`,
  ];
  const names: string[] = [];
  for (const x of rows) {
    const flags = `${x === ed.buffer ? "." : " "}${x.readOnly ? "%" : " "}${x.modified ? "*" : " "}`;
    lines.push(` ${flags} ${x.name.padEnd(nameW)}  ${String(x.doc.length).padStart(8)}  ${x.modeName.padEnd(modeW)}  ${x.filePath ?? ""}`);
    names.push(x.name);
  }
  b.meta.names = names;
  ed.setBufferText(b, lines.join("\n"));
  return b;
}

function bufferAtLine(ed: Editor): Buffer {
  const b = ed.buffer;
  const names = (b.meta.names as string[] | undefined) ?? [];
  const n = lineAtPoint(ed) - 3;
  const name = names[n];
  const target = name ? ed.getBuffer(name) : undefined;
  if (!target) throw new UserError("No buffer on this line");
  return target;
}

export function registerSpecialCommands(ed: Editor): void {
  ed.defineCommand("list-buffers", "Show the buffer list (C-x C-b)", (ed) => {
    const b = renderBufferList(ed);
    ed.popToBuffer(b);
    gotoLineOf(ed, b, 3);
  });
  ed.defineCommand("buffer-list-select", "Switch to the buffer on this line", (ed) => {
    const target = bufferAtLine(ed);
    ed.switchToBuffer(target);
  });
  ed.defineCommand("buffer-list-select-other-window", "Show the buffer on this line in another window", (ed) => {
    ed.popToBuffer(bufferAtLine(ed));
  });
  ed.defineCommand("buffer-list-kill", "Kill the buffer on this line", async (ed) => {
    const target = bufferAtLine(ed);
    const line = lineAtPoint(ed);
    if (await ed.killBuffer(target)) {
      const b = renderBufferList(ed);
      gotoLineOf(ed, b, line);
    }
  });
  ed.defineCommand("quit-window", "Leave the current special buffer (q)", (ed) => ed.quitWindow());

  // ---------------------------------------------------------------- dired
  ed.defineCommand("dired", "Open a directory listing (C-x d)", async (ed, arg) => {
    let dir = typeof arg === "string" ? arg : null;
    if (!dir) {
      dir = await ed.readFileName("Dired (directory): ", ed.buffer.defaultDirectory);
      if (!dir) return;
    }
    const b = await renderDired(ed, dir);
    ed.switchToBuffer(b);
    gotoLineOf(ed, b, 3);
  });
  ed.defineCommand("dired-find-file", "Open the file or directory on this line", async (ed) => {
    const p = diredPathAtLine(ed);
    await ed.findFile(p);
  });
  ed.defineCommand("dired-find-file-other-window", "Open the file on this line in another window", async (ed) => {
    const p = diredPathAtLine(ed);
    const b = await ed.findFile(p, ed.popToBuffer(ed.buffer, false));
    ed.popToBuffer(b);
  });
  ed.defineCommand("dired-up-directory", "Go to the parent directory (^)", async (ed) => {
    const cur = ed.buffer.meta.dir as string | undefined;
    if (!cur) throw new UserError("Not a dired buffer");
    const parent = await window.sumi.fs.dirname(cur.replace(/[\\/]$/, ""));
    const b = await renderDired(ed, parent);
    ed.switchToBuffer(b);
    gotoLineOf(ed, b, 3);
  });
  ed.defineCommand("dired-refresh", "Re-read the directory (g)", async (ed) => {
    const cur = ed.buffer.meta.dir as string | undefined;
    if (!cur) throw new UserError("Not a dired buffer");
    const line = lineAtPoint(ed);
    await renderDired(ed, cur);
    gotoLineOf(ed, ed.buffer, line);
  });
  ed.defineCommand("dired-create-directory", "Create a sub-directory here (+)", async (ed) => {
    const cur = ed.buffer.meta.dir as string | undefined;
    if (!cur) throw new UserError("Not a dired buffer");
    const name = await ed.minibuffer.read({ prompt: "Create directory: " });
    if (!name) return;
    const target = await window.sumi.fs.resolve(name, cur);
    const res = await window.sumi.shell.run(`mkdir "${target}"`, cur);
    if (res.code !== 0) throw new UserError(res.stderr || "mkdir failed");
    await renderDired(ed, cur);
  });
}

const diredKeymap = new Keymap("dired", {
  RET: "dired-find-file",
  f: "dired-find-file",
  e: "dired-find-file",
  o: "dired-find-file-other-window",
  "^": "dired-up-directory",
  g: "dired-refresh",
  "+": "dired-create-directory",
  q: "quit-window",
  n: "next-line",
  p: "previous-line",
});

async function renderDired(ed: Editor, dir: string): Promise<Buffer> {
  const res = await window.sumi.fs.readDir(dir);
  if (!res.ok) throw new UserError(`${dir}: ${res.error}`);
  const dirName = ensureSep(res.path, ed.sep);
  let b = ed.buffers.find((x) => x.kind === "special" && x.meta.dir === dirName);
  if (!b) b = ed.createBuffer(dirName, "", "special");
  b.readOnly = true;
  b.localKeymap = diredKeymap;
  b.modeName = "Dired";
  b.meta.dir = dirName;
  b.defaultDirectory = res.path;
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const lines = [`  ${dirName}:`, `  total ${res.entries.length}`];
  const paths: string[] = [];
  for (const e of res.entries) {
    lines.push(`  ${e.isDirectory ? "d" : "-"}  ${String(e.isDirectory ? "" : e.size).padStart(10)}  ${fmt(e.mtimeMs)}  ${e.name}${e.isDirectory ? ed.sep : ""}`);
    paths.push(e.path);
  }
  b.meta.paths = paths;
  ed.setBufferText(b, lines.join("\n"));
  return b;
}

function diredPathAtLine(ed: Editor): string {
  const paths = (ed.buffer.meta.paths as string[] | undefined) ?? [];
  const p = paths[lineAtPoint(ed) - 3];
  if (!p) throw new UserError("No file on this line");
  return p;
}

// ---------------------------------------------------------------- help

const helpKeymap = new Keymap("help", { q: "quit-window", n: "next-line", p: "previous-line" });

export function showHelpBuffer(ed: Editor, title: string, text: string): Buffer {
  const b = ed.getBufferCreate(title, "special");
  b.readOnly = true;
  b.localKeymap = helpKeymap;
  b.modeName = "Help";
  ed.setBufferText(b, text);
  ed.popToBuffer(b);
  gotoLineOf(ed, b, 1);
  return b;
}

export function describeBindingsText(ed: Editor): string {
  const out: string[] = [];
  const dump = (km: Keymap, heading: string) => {
    out.push(heading, "".padEnd(heading.length, "-"));
    const rows = [...km.bindings.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const w = Math.max(...rows.map(([k]) => k.length), 8);
    for (const [k, cmd] of rows) {
      const doc = ed.commands.get(cmd)?.doc ?? "";
      out.push(`${k.padEnd(w)}  ${cmd.padEnd(32)}  ${doc}`);
    }
    out.push("");
  };
  if (ed.buffer.localKeymap) dump(ed.buffer.localKeymap, `Local bindings (${ed.buffer.modeName})`);
  dump(ed.globalKeymap, "Global bindings");
  out.push("All commands (M-x)", "------------------");
  for (const c of [...ed.commands.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`${c.name.padEnd(36)} ${c.doc}`);
  }
  out.push("", "Editing keys (C-a C-e C-k C-y C-w M-w C-SPC C-/ M-/ M-; C-u ...) are provided by the Emacs layer of CodeMirror.");
  return out.join("\n");
}
