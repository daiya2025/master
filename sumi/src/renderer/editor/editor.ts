import { EditorSelection, EditorState, Text, type ChangeSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Buffer, type BufferKind } from "./buffer";
import { eventForKey, isSynthetic, keyName, Keymap } from "./keys";
import { Minibuffer } from "./minibuffer";
import { EditorWindow, Layout, syncAnnotation, type WindowHost } from "./window";
import { DEFAULT_SETTINGS, type Settings } from "../../shared/ipc";

export type CommandFn = (ed: Editor, arg?: unknown) => void | Promise<void>;

export interface Command {
  name: string;
  fn: CommandFn;
  doc: string;
}

export class UserError extends Error {}

/**
 * The editor: buffers, windows, commands, key dispatch, echo area. One instance per frame.
 */
export class Editor implements WindowHost {
  readonly buffers: Buffer[] = [];
  readonly commands = new Map<string, Command>();
  readonly globalKeymap = new Keymap("global");
  readonly minibuffer: Minibuffer;
  readonly layout: Layout;
  current: EditorWindow;
  settings: Settings = { ...DEFAULT_SETTINGS };
  lineNumbersEnabled = true;
  wrapEnabled = true;
  sep = "/";
  homeDir = "";
  private pending: string[] = [];
  private metaPending = false;
  private macro: string[] | null = null;
  private lastMacro: string[] = [];
  private macroReplaying = false;
  private readonly messagesBuffer: Buffer;
  /** Hooks run when C-g is pressed (abort streams etc.). */
  readonly quitHooks: (() => void)[] = [];
  /** Hooks run after a buffer is killed. */
  readonly killHooks: ((b: Buffer) => void)[] = [];

  constructor(
    frameEl: HTMLElement,
    minibufferRoot: HTMLElement,
  ) {
    this.minibuffer = new Minibuffer(minibufferRoot);
    const scratch = this.createBuffer("*scratch*", SCRATCH_TEXT, "scratch");
    scratch.modeName = "JavaScript";
    scratch.language = LanguageDescription.matchLanguageName(languages, "JavaScript", true);
    scratch.modified = false;
    this.messagesBuffer = this.createBuffer("*Messages*", "", "special");
    this.messagesBuffer.readOnly = true;
    this.current = new EditorWindow(this, scratch);
    this.layout = new Layout(frameEl, this.current);
    window.addEventListener("keydown", (e) => this.onKeyDown(e, false), true);
    this.current.focus();
    this.updateTitle();
  }

  // ---- settings -------------------------------------------------------

  applySettings(s: Settings): void {
    this.settings = s;
    document.body.dataset.theme = s.theme;
    document.documentElement.style.setProperty("--font-size", `${s.fontSize}px`);
    for (const w of this.windows) w.applyTheme(s.theme);
  }

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    const next = await window.sumi.settings.set(patch);
    this.applySettings(next);
  }

  // ---- echo / messages -----------------------------------------------

  echo(text: string, sticky = false): void {
    this.minibuffer.echo(text, sticky);
  }

  /** Like Emacs `message`: echo and log to *Messages*. */
  message(text: string): void {
    this.echo(text);
    this.appendToBuffer(this.messagesBuffer, (this.messagesBuffer.doc.length ? "\n" : "") + text, false);
  }

  error(text: string): void {
    this.message(text);
    document.body.classList.add("bell");
    setTimeout(() => document.body.classList.remove("bell"), 120);
  }

  // ---- commands --------------------------------------------------------

  defineCommand(name: string, doc: string, fn: CommandFn): void {
    this.commands.set(name, { name, fn, doc });
  }

  bind(seq: string, command: string, keymap: Keymap = this.globalKeymap): void {
    keymap.bind(seq, command);
  }

  async runCommand(name: string, arg?: unknown): Promise<void> {
    const cmd = this.commands.get(name);
    if (!cmd) {
      this.error(`No such command: ${name}`);
      return;
    }
    try {
      await cmd.fn(this, arg);
    } catch (err) {
      if (err instanceof UserError) this.error(err.message);
      else {
        console.error(err);
        this.error(`${name}: ${(err as Error).message ?? err}`);
      }
    }
  }

  /** Human readable key hint for a command, e.g. "C-x C-f". */
  keyHint(command: string): string {
    const keys = this.globalKeymap.keysFor(command);
    return keys.length ? keys[0] : `M-x ${command}`;
  }

  // ---- key dispatch ----------------------------------------------------

  /**
   * The single entry point for keys. `direct` is true when feedKey calls it with a synthetic
   * event; synthetic events seen through the DOM are our own replays into CodeMirror and are skipped.
   */
  private onKeyDown(e: KeyboardEvent, direct: boolean): void {
    if (isSynthetic(e) && !direct) return;
    if (e.isComposing) return;
    if (this.minibuffer.active) {
      if (this.minibuffer.handleKey(e, direct)) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (this.macro && !this.macroReplaying) this.recordKey(e);
      return;
    }
    let name = keyName(e);
    if (!name) return;
    if (this.metaPending) {
      this.metaPending = false;
      name = name.startsWith("M-") ? name : "M-" + name;
    }
    if (this.macro && !this.macroReplaying) this.recordKey(e, name);

    const seq = [...this.pending, name];
    const local = this.current.buffer.localKeymap?.lookup(seq);
    const binding = local ?? this.globalKeymap.lookup(seq);

    if (binding && "command" in binding) {
      e.preventDefault();
      e.stopPropagation();
      this.pending = [];
      this.echo("");
      void this.runCommand(binding.command);
      return;
    }
    if (binding && "prefix" in binding) {
      e.preventDefault();
      e.stopPropagation();
      this.pending = seq;
      this.echo(seq.join(" ") + "-", true);
      return;
    }
    if (this.pending.length) {
      e.preventDefault();
      e.stopPropagation();
      this.pending = [];
      if (seq[0] === "C-x" && EMACS_EXT_CX.has(seq.slice(1).join(" "))) {
        // Sequences the CodeMirror Emacs layer implements (mark ring, case, rectangles): hand them over.
        this.replayToView(seq);
        this.echo("");
      } else {
        this.error(`${seq.join(" ")} is undefined`);
      }
      return;
    }
    if (name === "ESC") {
      e.preventDefault();
      e.stopPropagation();
      this.metaPending = true;
      this.echo("ESC-", true);
      return;
    }
    // Not ours: CodeMirror (with the Emacs layer) handles it.
  }

  /** Dispatches a key sequence straight to the current CodeMirror view, bypassing our dispatcher. */
  replayToView(keys: string[]): void {
    for (const k of keys) this.current.view.contentDOM.dispatchEvent(eventForKey(k));
  }

  /** Feeds a key through the whole dispatcher as if typed (macros, tests). */
  feedKey(name: string): void {
    const ev = eventForKey(name);
    const wasInMinibuffer = this.minibuffer.active;
    // Phase 1: our dispatcher sees it...
    this.onKeyDown(ev, true);
    // Phase 2: ...and if it was not consumed, CodeMirror gets it. Plain characters are inserted
    // directly, because a synthetic keydown never produces the browser's input event.
    if (!ev.defaultPrevented && !wasInMinibuffer && !this.minibuffer.active) {
      const ch = name === "SPC" ? " " : name.length === 1 ? name : null;
      if (ch !== null) this.view.dispatch(this.view.state.replaceSelection(ch), { scrollIntoView: true });
      else this.current.view.contentDOM.dispatchEvent(eventForKey(name));
    }
  }

  feedKeys(seq: string): void {
    for (const k of seq.trim().split(/\s+/)) this.feedKey(k);
  }

  // ---- keyboard macros ------------------------------------------------

  private recordKey(e: KeyboardEvent, name = keyName(e)): void {
    if (!this.macro || !name) return;
    this.macro.push(name);
  }

  startMacro(): void {
    this.macro = [];
    this.message("Defining kbd macro...");
  }

  endMacro(): void {
    if (!this.macro) throw new UserError("Not defining kbd macro");
    // Drop the terminating "C-x )" itself.
    const m = this.macro;
    if (m.length >= 2 && m[m.length - 2] === "C-x" && m[m.length - 1] === ")") m.splice(-2, 2);
    this.lastMacro = m;
    this.macro = null;
    this.message("Keyboard macro defined");
  }

  async callLastMacro(): Promise<void> {
    if (this.macro) throw new UserError("Can't execute anonymous macro while defining one");
    if (!this.lastMacro.length) throw new UserError("No kbd macro has been defined");
    this.macroReplaying = true;
    try {
      for (const k of this.lastMacro) {
        this.feedKey(k);
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.macroReplaying = false;
    }
  }

  get definingMacro(): boolean {
    return this.macro !== null;
  }

  // ---- buffers ---------------------------------------------------------

  get windows(): EditorWindow[] {
    return this.layout.windows();
  }

  get buffer(): Buffer {
    return this.current.buffer;
  }

  get view(): EditorView {
    return this.current.view;
  }

  getBuffer(name: string): Buffer | undefined {
    return this.buffers.find((b) => b.name === name);
  }

  bufferForFile(path: string): Buffer | undefined {
    const norm = normalizePath(path);
    return this.buffers.find((b) => b.filePath && normalizePath(b.filePath) === norm);
  }

  uniqueBufferName(base: string): string {
    if (!this.getBuffer(base)) return base;
    for (let i = 2; ; i++) {
      const n = `${base}<${i}>`;
      if (!this.getBuffer(n)) return n;
    }
  }

  createBuffer(name: string, text = "", kind: BufferKind = "file"): Buffer {
    const b = new Buffer(this.uniqueBufferName(name), text, kind);
    b.defaultDirectory = this.buffers[0]?.defaultDirectory ?? null;
    this.buffers.push(b);
    return b;
  }

  /** Returns the existing buffer or creates it (get-buffer-create). */
  getBufferCreate(name: string, kind: BufferKind = "special"): Buffer {
    return this.getBuffer(name) ?? this.createBuffer(name, "", kind);
  }

  /** Moves the buffer to the front of the buffer list (most recently used). */
  private touch(b: Buffer): void {
    const i = this.buffers.indexOf(b);
    if (i > 0) {
      this.buffers.splice(i, 1);
      this.buffers.unshift(b);
    }
  }

  switchToBuffer(b: Buffer, win: EditorWindow = this.current): void {
    win.showBuffer(b);
    this.touch(b);
    this.updateModelines();
    this.updateTitle();
    win.focus();
  }

  /** Shows a buffer in another window (splitting if there is only one) and returns that window. */
  popToBuffer(b: Buffer, select = true): EditorWindow {
    let win = this.windows.find((w) => w.buffer === b);
    if (!win) {
      const others = this.windows.filter((w) => w !== this.current);
      if (others.length) win = others[0];
      else win = this.splitWindow("column", false);
      win.showBuffer(b);
      this.touch(b);
    }
    if (select) this.selectWindow(win);
    else this.updateModelines();
    return win;
  }

  /** Most recently used buffer other than the given one (for switch-to-buffer's default). */
  otherBuffer(not: Buffer = this.buffer): Buffer | undefined {
    return this.buffers.find((b) => b !== not && b.kind !== "special") ?? this.buffers.find((b) => b !== not);
  }

  async killBuffer(b: Buffer): Promise<boolean> {
    if (b.modified && b.kind === "file") {
      const ok = await this.minibuffer.yesOrNo(`Buffer ${b.name} modified; kill anyway?`);
      if (!ok) return false;
    }
    if (b.kind === "scratch" && b.name === "*scratch*") {
      b.setText("");
      b.modified = false;
      this.refreshViewsOf(b);
      this.message("*scratch* を空にしました");
      return true;
    }
    const idx = this.buffers.indexOf(b);
    if (idx >= 0) this.buffers.splice(idx, 1);
    for (const hook of b.onKill) hook();
    for (const w of this.windows) {
      if (w.buffer === b) {
        const next = (w.prevBuffer && this.buffers.includes(w.prevBuffer) ? w.prevBuffer : null) ?? this.otherBuffer(b) ?? this.getBufferCreate("*scratch*", "scratch");
        w.showBuffer(next);
      }
    }
    for (const hook of this.killHooks) hook(b);
    this.updateModelines();
    this.updateTitle();
    return true;
  }

  /** Re-creates view states for windows showing the buffer after an out-of-band text change. */
  refreshViewsOf(b: Buffer): void {
    for (const w of this.windows) {
      if (w.buffer === b) {
        const cur = w.view.state;
        w.view.dispatch({
          changes: { from: 0, to: cur.doc.length, insert: b.doc },
          annotations: syncAnnotation.of(true),
        });
      }
    }
    this.updateModelines();
  }

  /** Applies a change to a buffer whether or not it is visible; keeps undo history where it is shown. */
  changeBuffer(b: Buffer, changes: ChangeSpec, markModified = true, scrollTo?: "end"): void {
    const win = this.windows.find((w) => w.buffer === b);
    if (win) {
      const atEnd = win.view.state.selection.main.head === win.view.state.doc.length;
      win.view.dispatch({ changes, annotations: syncAnnotation.of(!markModified) });
      if (scrollTo === "end" && atEnd) {
        const len = win.view.state.doc.length;
        win.view.dispatch({ selection: EditorSelection.cursor(len), scrollIntoView: true });
      }
    } else {
      // Apply through a throwaway state so ChangeSpec semantics match CodeMirror's.
      const tmp = EditorState.create({ doc: b.doc });
      b.doc = tmp.update({ changes }).state.doc;
      b.savedSelection = EditorSelection.single(Math.min(b.savedSelection.main.head, b.doc.length));
    }
    if (markModified) b.modified = true;
    this.updateModelines();
  }

  appendToBuffer(b: Buffer, text: string, markModified = true): void {
    this.changeBuffer(b, { from: b.doc.length, insert: text }, markModified, "end");
  }

  /** Replaces the whole buffer text (special buffers re-rendering themselves). */
  setBufferText(b: Buffer, text: string, markModified = false): void {
    this.changeBuffer(b, { from: 0, to: b.doc.length, insert: text }, markModified);
  }

  // ---- files -----------------------------------------------------------

  async findFile(path: string, win: EditorWindow = this.current): Promise<Buffer> {
    const existing = this.bufferForFile(path);
    if (existing) {
      this.switchToBuffer(existing, win);
      return existing;
    }
    const res = await window.sumi.fs.readFile(path);
    if (!res.ok && res.isDirectory) {
      return this.runCommand("dired", path).then(() => this.buffer);
    }
    const name = baseName(path, this.sep);
    const b = this.createBuffer(name, res.ok ? res.text : "", "file");
    b.filePath = path;
    b.defaultDirectory = await window.sumi.fs.dirname(path);
    b.modified = false;
    this.detectLanguage(b);
    if (!res.ok && !res.notFound) {
      this.error(`${path}: ${res.error}`);
    }
    this.switchToBuffer(b, win);
    if (!res.ok && res.notFound) this.message("(New file)");
    return b;
  }

  detectLanguage(b: Buffer): void {
    if (!b.filePath) return;
    const desc = LanguageDescription.matchFilename(languages, b.filePath);
    b.language = desc;
    b.modeName = desc ? desc.name : "Text";
    for (const w of this.windows) if (w.buffer === b) void w.loadLanguage(b);
  }

  async saveBuffer(b: Buffer = this.buffer): Promise<boolean> {
    if (b.kind !== "file" && b.kind !== "scratch") throw new UserError(`Buffer ${b.name} is not visiting a file`);
    if (!b.filePath) {
      const target = await this.readFileName("Write file: ", b.defaultDirectory);
      if (!target) return false;
      b.filePath = target;
      b.name = this.uniqueBufferName(baseName(target, this.sep));
      b.defaultDirectory = await window.sumi.fs.dirname(target);
      this.detectLanguage(b);
    }
    if (!b.modified && b.filePath) {
      this.message("(No changes need to be saved)");
      return true;
    }
    const res = await window.sumi.fs.writeFile(b.filePath, b.text);
    if (!res.ok) throw new UserError(`Save failed: ${res.error}`);
    b.modified = false;
    this.updateModelines();
    this.updateTitle();
    this.message(`Wrote ${b.filePath}`);
    return true;
  }

  /** Reads a file name with directory completion. */
  async readFileName(prompt: string, dir: string | null, initialName = ""): Promise<string | null> {
    const base = dir ?? this.homeDir;
    const initial = ensureSep(base, this.sep) + initialName;
    const sep = this.sep;
    const completions = async (input: string): Promise<string[]> => {
      const resolved = input ? await window.sumi.fs.resolve(input, base) : base;
      const endsWithSep = /[\\/]$/.test(input) || input === "";
      const dirPath = endsWithSep ? resolved : await window.sumi.fs.dirname(resolved);
      const partial = endsWithSep ? "" : baseName(resolved, sep).toLowerCase();
      const res = await window.sumi.fs.readDir(dirPath);
      if (!res.ok) return [];
      return res.entries
        .filter((e) => e.name.toLowerCase().startsWith(partial))
        .map((e) => ensureSep(dirPath, sep) + e.name + (e.isDirectory ? sep : ""));
    };
    const answer = await this.minibuffer.read({ prompt, initial, completions, history: "file" });
    if (answer === null) return null;
    return window.sumi.fs.resolve(answer, base);
  }

  // ---- windows ---------------------------------------------------------

  selectWindow(win: EditorWindow): void {
    this.current = win;
    this.touch(win.buffer);
    this.updateModelines();
    this.updateTitle();
    win.focus();
  }

  splitWindow(dir: "row" | "column", select = false): EditorWindow {
    const win = new EditorWindow(this, this.current.buffer);
    win.view.dispatch({ selection: this.current.view.state.selection });
    this.layout.split(this.current, dir, win);
    if (select) this.selectWindow(win);
    else this.updateModelines();
    return win;
  }

  deleteWindow(win: EditorWindow = this.current): void {
    if (this.windows.length <= 1) throw new UserError("Attempt to delete sole window");
    const all = this.windows;
    const idx = all.indexOf(win);
    this.layout.remove(win);
    win.destroy();
    if (win === this.current) {
      const remaining = this.windows;
      this.selectWindow(remaining[Math.min(idx, remaining.length - 1)] ?? remaining[0]);
    } else this.updateModelines();
  }

  deleteOtherWindows(): void {
    for (const w of this.windows) if (w !== this.current) w.destroy();
    this.layout.keepOnly(this.current);
    this.selectWindow(this.current);
  }

  otherWindow(delta = 1): void {
    const all = this.windows;
    if (all.length < 2) return;
    const i = all.indexOf(this.current);
    this.selectWindow(all[(i + delta + all.length) % all.length]);
  }

  /** Quit a special buffer's window: restore the previous buffer or close the window. */
  quitWindow(win: EditorWindow = this.current): void {
    const prev = win.prevBuffer && this.buffers.includes(win.prevBuffer) ? win.prevBuffer : null;
    if (this.windows.length > 1 && (!prev || this.windows.some((w) => w !== win && w.buffer === prev))) {
      this.deleteWindow(win);
    } else if (prev) {
      this.switchToBuffer(prev, win);
    } else {
      this.switchToBuffer(this.otherBuffer(win.buffer) ?? this.getBufferCreate("*scratch*", "scratch"), win);
    }
  }

  updateModelines(): void {
    for (const w of this.windows) w.updateModeline(w === this.current);
  }

  updateTitle(): void {
    const b = this.buffer;
    window.sumi.app.setTitle(`${b.modified ? "*" : ""}${b.name}${b.filePath ? ` — ${b.filePath}` : ""} — Sumi`);
  }

  // ---- WindowHost ------------------------------------------------------

  onViewUpdate(win: EditorWindow, u: ViewUpdate): void {
    const b = win.buffer;
    if (u.docChanged) {
      b.syncFrom(win.view.state);
      const tr = win.view.state; // mirror into sibling windows
      for (const other of this.windows) {
        if (other !== win && other.buffer === b && other.view.state.doc !== tr.doc) {
          other.view.dispatch({
            changes: { from: 0, to: other.view.state.doc.length, insert: tr.doc },
            annotations: syncAnnotation.of(true),
          });
        }
      }
      // A user edit (not a sync mirror) marks the buffer modified.
      const isSync = u.transactions.some((tr) => tr.annotation(syncAnnotation) === true);
      if (!isSync && !b.readOnly && b.kind !== "special") b.modified = true;
      this.updateTitle();
    }
    win.updateModeline(win === this.current);
  }

  onWindowFocus(win: EditorWindow): void {
    if (win !== this.current) {
      this.current = win;
      this.touch(win.buffer);
      this.updateModelines();
      this.updateTitle();
    }
  }

  // ---- misc helpers ----------------------------------------------------

  /** Current region text, or null when the selection is empty. */
  regionText(): string | null {
    const sel = this.view.state.selection.main;
    return sel.empty ? null : this.view.state.sliceDoc(sel.from, sel.to);
  }

  insertAtPoint(text: string): void {
    const sel = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: EditorSelection.cursor(sel.from + text.length),
      scrollIntoView: true,
    });
  }

  gotoLine(n: number): void {
    const doc = this.view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, n)));
    this.view.dispatch({ selection: EditorSelection.cursor(line.from), scrollIntoView: true });
  }
}

/** C-x sequences implemented by @replit/codemirror-emacs that we forward instead of defining ourselves. */
const EMACS_EXT_CX = new Set(["C-x", "h", "C-p", "u", "C-u", "C-l", "r"]);

export const SCRATCH_TEXT = `// This buffer is for JavaScript you can evaluate with C-x C-e (eval line) or C-j (eval & print).
// 日本語入力もそのまま使えます。ファイルを開くには C-x C-f、コマンドは M-x、ヘルプは C-h t。
// Claude とチャット: C-c c   選択範囲について質問: C-c a   書き換え: C-c r

`;

export function baseName(path: string, sep: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function ensureSep(dir: string, sep: string): string {
  return /[\\/]$/.test(dir) ? dir : dir + sep;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export { Text };
