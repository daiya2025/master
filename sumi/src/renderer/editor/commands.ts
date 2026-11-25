import { EditorSelection } from "@codemirror/state";
import { cursorLineDown, cursorLineUp } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { Editor, UserError, baseName } from "./editor";
import { completeFrom } from "./minibuffer";
import { isearch } from "./isearch";
import { describeBindingsText, registerSpecialCommands, showHelpBuffer } from "./special";
import { TUTORIAL_TEXT } from "./tutorial";

/** Registers the built-in command set and the global key bindings. */
export function registerBuiltinCommands(ed: Editor): void {
  const def = (name: string, doc: string, fn: (ed: Editor, arg?: unknown) => void | Promise<void>) => ed.defineCommand(name, doc, fn);

  // ---- files
  def("find-file", "Open a file (creates it if missing)", async (ed, arg) => {
    const path = typeof arg === "string" ? arg : await ed.readFileName("Find file: ", ed.buffer.defaultDirectory);
    if (!path) return;
    await ed.findFile(path);
  });
  def("find-file-other-window", "Open a file in another window", async (ed) => {
    const path = await ed.readFileName("Find file in other window: ", ed.buffer.defaultDirectory);
    if (!path) return;
    const b = await ed.findFile(path, ed.popToBuffer(ed.buffer, false));
    ed.popToBuffer(b);
  });
  def("find-file-dialog", "Open a file with the Windows file dialog", async (ed) => {
    const p = await window.sumi.fs.openDialog(ed.buffer.defaultDirectory ?? undefined);
    if (p) await ed.findFile(p);
  });
  def("save-buffer", "Save the current buffer to its file", async (ed) => {
    await ed.saveBuffer();
  });
  def("write-file", "Save the buffer under a new name", async (ed) => {
    const b = ed.buffer;
    if (b.kind === "special") throw new UserError("Cannot write a special buffer");
    const target = await ed.readFileName("Write file: ", b.defaultDirectory, b.filePath ? baseName(b.filePath, ed.sep) : "");
    if (!target) return;
    b.filePath = target;
    b.name = ed.uniqueBufferName(baseName(target, ed.sep));
    b.defaultDirectory = await window.sumi.fs.dirname(target);
    b.modified = true;
    ed.detectLanguage(b);
    await ed.saveBuffer(b);
  });
  def("save-some-buffers", "Save every modified file buffer, asking for each", async (ed) => {
    let n = 0;
    for (const b of [...ed.buffers]) {
      if (b.modified && b.kind === "file") {
        if (await ed.minibuffer.yesOrNo(`Save file ${b.filePath ?? b.name}?`)) {
          await ed.saveBuffer(b);
          n++;
        }
      }
    }
    ed.message(n ? `Saved ${n} buffer(s)` : "(No files need saving)");
  });
  def("revert-buffer", "Re-read the current buffer from disk", async (ed) => {
    const b = ed.buffer;
    if (!b.filePath) throw new UserError("Buffer does not visit a file");
    if (b.modified && !(await ed.minibuffer.yesOrNo("Discard edits and reread from disk?"))) return;
    const res = await window.sumi.fs.readFile(b.filePath);
    if (!res.ok) throw new UserError(res.error);
    ed.setBufferText(b, res.text);
    b.modified = false;
    ed.updateModelines();
    ed.message("Reverted");
  });
  def("save-buffers-kill-terminal", "Save changed buffers and quit Sumi", async (ed) => {
    const dirty = ed.buffers.filter((b) => b.modified && b.kind === "file");
    for (const b of dirty) {
      if (await ed.minibuffer.yesOrNo(`Save file ${b.filePath ?? b.name}?`)) await ed.saveBuffer(b);
    }
    const stillDirty = ed.buffers.filter((b) => b.modified && b.kind === "file");
    if (stillDirty.length && !(await ed.minibuffer.yesOrNo("Modified buffers exist; exit anyway?"))) return;
    window.sumi.app.quit();
  });

  // ---- buffers
  def("switch-to-buffer", "Switch to a buffer by name (creates it if new)", async (ed) => {
    const other = ed.otherBuffer();
    const name = await ed.minibuffer.read({
      prompt: "Switch to buffer: ",
      defaultValue: other?.name,
      completions: completeFrom(() => ed.buffers.filter((b) => b !== ed.buffer).map((b) => b.name)),
      history: "buffer",
    });
    if (name === null) return;
    const b = ed.getBuffer(name) ?? ed.createBuffer(name, "", "file");
    ed.switchToBuffer(b);
  });
  def("switch-to-buffer-other-window", "Show a buffer in another window", async (ed) => {
    const name = await ed.minibuffer.read({
      prompt: "Switch to buffer in other window: ",
      completions: completeFrom(() => ed.buffers.map((b) => b.name)),
      history: "buffer",
    });
    if (name === null) return;
    ed.popToBuffer(ed.getBuffer(name) ?? ed.createBuffer(name, "", "file"));
  });
  def("kill-buffer", "Kill a buffer", async (ed) => {
    const name = await ed.minibuffer.read({
      prompt: "Kill buffer: ",
      defaultValue: ed.buffer.name,
      completions: completeFrom(() => ed.buffers.map((b) => b.name)),
      requireMatch: true,
    });
    if (name === null) return;
    const b = ed.getBuffer(name);
    if (b) await ed.killBuffer(b);
  });
  def("rename-buffer", "Rename the current buffer", async (ed) => {
    const name = await ed.minibuffer.read({ prompt: "Rename buffer (to new name): ", initial: ed.buffer.name });
    if (!name) return;
    ed.buffer.name = ed.uniqueBufferName(name);
    ed.updateModelines();
    ed.updateTitle();
  });
  def("toggle-read-only", "Toggle read-only for the current buffer", (ed) => {
    const b = ed.buffer;
    b.readOnly = !b.readOnly;
    for (const w of ed.windows) if (w.buffer === b) w.setReadOnly(b.readOnly);
    ed.updateModelines();
    ed.message(b.readOnly ? "Read-only mode enabled" : "Read-only mode disabled");
  });

  // ---- windows
  def("split-window-below", "Split the window above/below (C-x 2)", (ed) => void ed.splitWindow("column"));
  def("split-window-right", "Split the window side by side (C-x 3)", (ed) => void ed.splitWindow("row"));
  def("delete-window", "Close the current window (C-x 0)", (ed) => ed.deleteWindow());
  def("delete-other-windows", "Keep only the current window (C-x 1)", (ed) => ed.deleteOtherWindows());
  def("other-window", "Move to the next window (C-x o)", (ed) => ed.otherWindow(1));
  def("previous-window", "Move to the previous window", (ed) => ed.otherWindow(-1));
  def("kill-buffer-and-window", "Kill the buffer and close its window", async (ed) => {
    const win = ed.current;
    if (await ed.killBuffer(ed.buffer)) if (ed.windows.length > 1) ed.deleteWindow(win);
  });

  // ---- movement & editing helpers
  def("next-line", "Move down one line", (ed) => void cursorLineDown(ed.view));
  def("previous-line", "Move up one line", (ed) => void cursorLineUp(ed.view));
  def("goto-line", "Jump to a line number (M-g g)", async (ed, arg) => {
    const s = typeof arg === "number" ? String(arg) : await ed.minibuffer.read({ prompt: "Goto line: ", history: "goto-line" });
    if (!s) return;
    const n = parseInt(s, 10);
    if (Number.isNaN(n)) throw new UserError("Not a number");
    ed.gotoLine(n);
  });
  def("beginning-of-buffer", "Go to the start of the buffer (M-<)", (ed) => {
    ed.view.dispatch({ selection: EditorSelection.cursor(0), scrollIntoView: true });
  });
  def("end-of-buffer", "Go to the end of the buffer (M->)", (ed) => {
    ed.view.dispatch({ selection: EditorSelection.cursor(ed.view.state.doc.length), scrollIntoView: true });
  });
  def("isearch-forward", "Incremental search forward (C-s)", (ed) => isearch(ed, true));
  def("isearch-backward", "Incremental search backward (C-r)", (ed) => isearch(ed, false));
  def("query-replace", "Search and replace with the search panel (M-%)", (ed) => {
    openSearchPanel(ed.view);
  });
  def("keyboard-quit", "Cancel the current command / deselect (C-g)", (ed) => {
    for (const hook of ed.quitHooks) hook();
    ed.replayToView(["C-g"]);
    ed.echo("Quit");
  });
  def("what-line", "Show the current line number", (ed) => {
    const st = ed.view.state;
    ed.message(`Line ${st.doc.lineAt(st.selection.main.head).number} of ${st.doc.lines}`);
  });
  def("count-words", "Count lines, words and characters in the buffer or region", (ed) => {
    const text = ed.regionText() ?? ed.view.state.doc.toString();
    const words = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).length;
    ed.message(`${ed.regionText() ? "Region" : "Buffer"} has ${text.split("\n").length} lines, ${words} words, and ${text.length} characters`);
  });
  def("delete-trailing-whitespace", "Remove trailing spaces on every line", (ed) => {
    const doc = ed.view.state.doc;
    const changes = [];
    for (let i = 1; i <= doc.lines; i++) {
      const l = doc.line(i);
      const m = /\s+$/.exec(l.text);
      if (m) changes.push({ from: l.to - m[0].length, to: l.to });
    }
    if (changes.length) ed.view.dispatch({ changes });
    ed.message(`Removed trailing whitespace on ${changes.length} line(s)`);
  });
  def("sort-lines", "Sort the lines in the region", (ed) => {
    const sel = ed.view.state.selection.main;
    if (sel.empty) throw new UserError("No region");
    const doc = ed.view.state.doc;
    const from = doc.lineAt(sel.from).from;
    const to = doc.lineAt(sel.to).to;
    const sorted = doc.sliceString(from, to).split("\n").sort((a, b) => a.localeCompare(b)).join("\n");
    ed.view.dispatch({ changes: { from, to, insert: sorted } });
  });

  // ---- keyboard macros
  def("kmacro-start-macro", "Start recording a keyboard macro (C-x ()", (ed) => ed.startMacro());
  def("kmacro-end-macro", "Stop recording the keyboard macro (C-x ))", (ed) => ed.endMacro());
  def("kmacro-end-and-call-macro", "Replay the last keyboard macro (C-x e)", async (ed) => {
    if (ed.definingMacro) ed.endMacro();
    await ed.callLastMacro();
  });

  // ---- M-x and evaluation
  def("execute-extended-command", "Run a command by name (M-x)", async (ed) => {
    const name = await ed.minibuffer.read({
      prompt: "M-x ",
      completions: completeFrom(() => [...ed.commands.keys()].sort()),
      requireMatch: true,
      history: "M-x",
    });
    if (name) await ed.runCommand(name);
  });
  def("eval-expression", "Evaluate a JavaScript expression (M-:)", async (ed) => {
    const src = await ed.minibuffer.read({ prompt: "Eval: ", history: "eval" });
    if (src === null) return;
    ed.message(formatValue(await evalJs(ed, src)));
  });
  def("eval-last-sexp", "Evaluate the region or current line as JavaScript (C-x C-e)", async (ed) => {
    const st = ed.view.state;
    const src = ed.regionText() ?? st.doc.lineAt(st.selection.main.head).text;
    ed.message(formatValue(await evalJs(ed, src)));
  });
  def("eval-print-last-sexp", "Evaluate the current line and insert the result below (C-j in *scratch*)", async (ed) => {
    const st = ed.view.state;
    const line = st.doc.lineAt(st.selection.main.head);
    const src = ed.regionText() ?? line.text;
    const result = formatValue(await evalJs(ed, src));
    ed.view.dispatch({
      changes: { from: line.to, insert: `\n${result}\n` },
      selection: EditorSelection.cursor(line.to + result.length + 2),
      scrollIntoView: true,
    });
  });

  // ---- shell
  def("shell-command", "Run a shell command and show its output (M-!)", async (ed) => {
    const cmd = await ed.minibuffer.read({ prompt: "Shell command: ", history: "shell" });
    if (!cmd) return;
    ed.echo(`Running: ${cmd} ...`, true);
    const res = await window.sumi.shell.run(cmd, ed.buffer.defaultDirectory);
    const out = res.stdout + (res.stderr ? (res.stdout ? "\n" : "") + res.stderr : "") + (res.error ? `\n${res.error}` : "");
    const trimmed = out.replace(/\s+$/, "");
    if (!trimmed) ed.message(`(Shell command ${res.code === 0 ? "succeeded" : "failed"} with no output)`);
    else if (!trimmed.includes("\n") && trimmed.length < 200) ed.message(trimmed);
    else {
      const b = ed.getBufferCreate("*Shell Command Output*", "special");
      b.readOnly = true;
      b.modeName = "Shell Output";
      ed.setBufferText(b, trimmed);
      ed.popToBuffer(b, false);
      ed.echo(res.code === 0 ? "" : `(Exit code ${res.code})`);
    }
  });
  def("shell-command-on-region", "Pipe the region through a shell command and replace it (M-|)", async (ed) => {
    const sel = ed.view.state.selection.main;
    if (sel.empty) throw new UserError("No region");
    const cmd = await ed.minibuffer.read({ prompt: "Shell command on region (replaces region): ", history: "shell" });
    if (!cmd) return;
    const res = await window.sumi.shell.run(cmd, ed.buffer.defaultDirectory, ed.view.state.sliceDoc(sel.from, sel.to));
    if (res.code !== 0) throw new UserError(res.stderr.trim() || `Exit code ${res.code}`);
    ed.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: res.stdout } });
  });

  // ---- appearance
  def("toggle-theme", "Switch between the dark and light theme", async (ed) => {
    await ed.saveSettings({ theme: ed.settings.theme === "dark" ? "light" : "dark" });
  });
  def("text-scale-increase", "Larger text (C-x C-+)", async (ed) => {
    await ed.saveSettings({ fontSize: Math.min(40, ed.settings.fontSize + 1) });
  });
  def("text-scale-decrease", "Smaller text (C-x C--)", async (ed) => {
    await ed.saveSettings({ fontSize: Math.max(8, ed.settings.fontSize - 1) });
  });
  def("text-scale-reset", "Default text size (C-x C-0)", async (ed) => {
    await ed.saveSettings({ fontSize: 15 });
  });
  def("toggle-line-numbers", "Show or hide line numbers", (ed) => {
    ed.lineNumbersEnabled = !ed.lineNumbersEnabled;
    for (const w of ed.windows) w.setLineNumbers(ed.lineNumbersEnabled);
  });
  def("toggle-truncate-lines", "Toggle line wrapping", (ed) => {
    ed.wrapEnabled = !ed.wrapEnabled;
    for (const w of ed.windows) w.setWrap(ed.wrapEnabled);
    ed.message(ed.wrapEnabled ? "Wrapping long lines" : "Truncating long lines");
  });

  // ---- help
  def("describe-bindings", "List all key bindings and commands (C-h b)", (ed) => {
    showHelpBuffer(ed, "*Help*", describeBindingsText(ed));
  });
  def("describe-key", "Show what a key sequence does (C-h k)", async (ed) => {
    const all = [...(ed.buffer.localKeymap?.bindings.keys() ?? []), ...ed.globalKeymap.bindings.keys()];
    const key = await ed.minibuffer.read({ prompt: "Describe key: ", completions: completeFrom(all), requireMatch: true });
    if (!key) return;
    const cmd = ed.buffer.localKeymap?.bindings.get(key) ?? ed.globalKeymap.bindings.get(key);
    if (!cmd) throw new UserError(`${key} is undefined`);
    ed.message(`${key} runs the command ${cmd}: ${ed.commands.get(cmd)?.doc ?? ""}`);
  });
  def("describe-command", "Show a command's documentation", async (ed) => {
    const name = await ed.minibuffer.read({ prompt: "Describe command: ", completions: completeFrom(() => [...ed.commands.keys()].sort()), requireMatch: true });
    if (!name) return;
    const keys = ed.globalKeymap.keysFor(name);
    ed.message(`${name}${keys.length ? ` (${keys.join(", ")})` : ""}: ${ed.commands.get(name)?.doc ?? ""}`);
  });
  def("help-with-tutorial", "Open the Sumi tutorial (C-h t)", (ed) => {
    showHelpBuffer(ed, "*Tutorial*", TUTORIAL_TEXT);
  });
  def("view-messages", "Show the *Messages* log", (ed) => {
    const b = ed.getBuffer("*Messages*");
    if (b) ed.popToBuffer(b);
  });
  def("about-sumi", "Version information", async (ed) => {
    ed.message(`Sumi ${await window.sumi.app.version()} — Emacs-style editor with Claude. ${ed.commands.size} commands loaded.`);
  });

  registerSpecialCommands(ed);

  // ---- global bindings
  const bindings: Record<string, string> = {
    "C-x C-f": "find-file",
    "C-x 4 f": "find-file-other-window",
    "C-x 4 b": "switch-to-buffer-other-window",
    "C-x C-s": "save-buffer",
    "C-x C-w": "write-file",
    "C-x s": "save-some-buffers",
    "C-x C-c": "save-buffers-kill-terminal",
    "C-x b": "switch-to-buffer",
    "C-x C-b": "list-buffers",
    "C-x k": "kill-buffer",
    "C-x d": "dired",
    "C-x C-q": "toggle-read-only",
    "C-x 0": "delete-window",
    "C-x 1": "delete-other-windows",
    "C-x 2": "split-window-below",
    "C-x 3": "split-window-right",
    "C-x o": "other-window",
    "C-x 4 0": "kill-buffer-and-window",
    "C-x (": "kmacro-start-macro",
    "C-x )": "kmacro-end-macro",
    "C-x e": "kmacro-end-and-call-macro",
    "C-x C-e": "eval-last-sexp",
    "C-x C-+": "text-scale-increase",
    "C-x C-=": "text-scale-increase",
    "C-x C--": "text-scale-decrease",
    "C-x C-0": "text-scale-reset",
    "M-x": "execute-extended-command",
    "M-:": "eval-expression",
    "M-!": "shell-command",
    "M-|": "shell-command-on-region",
    "M-<": "beginning-of-buffer",
    "M->": "end-of-buffer",
    "M-g g": "goto-line",
    "M-g M-g": "goto-line",
    "M-%": "query-replace",
    "C-s": "isearch-forward",
    "C-r": "isearch-backward",
    "C-g": "keyboard-quit",
    "C-h b": "describe-bindings",
    "C-h k": "describe-key",
    "C-h f": "describe-command",
    "C-h t": "help-with-tutorial",
    "C-h C-h": "help-with-tutorial",
    "C-h e": "view-messages",
    "<f1>": "help-with-tutorial",
    "<f10>": "execute-extended-command",
    "<f3>": "kmacro-start-macro",
    "<f4>": "kmacro-end-and-call-macro",
  };
  for (const [k, v] of Object.entries(bindings)) ed.bind(k, v);
}

async function evalJs(ed: Editor, src: string): Promise<unknown> {
  // The editor is exposed as `editor`, the current CodeMirror view as `view`.
  const fn = new Function("editor", "view", "sumi", `return (async () => (${src.trim().replace(/;$/, "")}))()`);
  try {
    return await fn(ed, ed.view, window.sumi);
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Not an expression - run it as statements.
      const stmt = new Function("editor", "view", "sumi", `return (async () => { ${src} })()`);
      return await stmt(ed, ed.view, window.sumi);
    }
    throw err;
  }
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}
