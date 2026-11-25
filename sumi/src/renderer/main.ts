import { Editor } from "./editor/editor";
import { registerBuiltinCommands } from "./editor/commands";
import { registerClaude } from "./claude/claude";
import { indentUnit } from "@codemirror/language";
import { Keymap } from "./editor/keys";

declare global {
  interface Window {
    /** The live editor instance, handy for M-: and for the smoke test. */
    editor: Editor;
    __sumiReady: boolean;
  }
}

void indentUnit; // keep the import list honest for future indentation settings

async function boot(): Promise<void> {
  const frame = document.getElementById("frame")!;
  const mbRoot = document.getElementById("minibuffer-area")!;
  const ed = new Editor(frame, mbRoot);
  window.editor = ed;

  registerBuiltinCommands(ed);
  registerClaude(ed);

  // *scratch* evaluates with C-j like lisp-interaction-mode.
  const scratch = ed.getBuffer("*scratch*");
  if (scratch) scratch.localKeymap = new Keymap("scratch", { "C-j": "eval-print-last-sexp" });

  const [settings, sep, home, cwd, args] = await Promise.all([
    window.sumi.settings.get(),
    window.sumi.fs.sep(),
    window.sumi.fs.homeDir(),
    window.sumi.fs.cwd(),
    window.sumi.app.args(),
  ]);
  ed.sep = sep;
  ed.homeDir = home;
  for (const b of ed.buffers) b.defaultDirectory = cwd;
  ed.applySettings(settings);

  for (const f of args) await ed.findFile(f);
  window.addEventListener("sumi:openFiles", (e) => {
    for (const f of (e as CustomEvent<string[]>).detail) void ed.findFile(f);
  });

  window.addEventListener("beforeunload", (e) => {
    if (ed.buffers.some((b) => b.modified && b.kind === "file")) {
      e.preventDefault();
      ed.error("Modified buffers exist — use C-x C-c to quit (it asks to save)");
    }
  });

  ed.message(
    settings.apiKeySource === "none"
      ? "Welcome to Sumi.  C-h t: tutorial   M-x claude-set-api-key: Claude を有効化"
      : "Welcome to Sumi.  C-h t: tutorial   C-c c: Claude chat",
  );
  window.__sumiReady = true;
}

void boot();
