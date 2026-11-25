import { EditorSelection } from "@codemirror/state";
import type { Editor } from "../editor/editor";
import type { BetaTool } from "../../shared/ipc";

/** Tools Claude can call to look at and change the editor. Executed in the renderer. */
export const TOOLS: BetaTool[] = [
  {
    name: "list_buffers",
    description: "List open buffers with their file paths, modes, line counts and which one is current.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "read_buffer",
    description: "Read the text of a buffer, with line numbers. Omit start_line/end_line to read everything (large buffers are capped at 2000 lines per call).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Buffer name as shown by list_buffers (e.g. 'main.ts')." },
        start_line: { type: ["integer", "null"], description: "1-based first line." },
        end_line: { type: ["integer", "null"], description: "1-based last line (inclusive)." },
      },
      required: ["name", "start_line", "end_line"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_selection",
    description: "Return the current buffer name, point (line/column) and the selected region text, if any.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "edit_buffer",
    description: "Replace one exact occurrence of old_text with new_text in a buffer. old_text must appear exactly once; include enough context to be unique. The user can undo with C-/.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["name", "old_text", "new_text"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "replace_buffer",
    description: "Replace the entire contents of a buffer. Prefer edit_buffer for small changes.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, text: { type: "string" } },
      required: ["name", "text"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "insert_at_point",
    description: "Insert text at the cursor position of the current (non-chat) buffer.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "create_buffer",
    description: "Create a new buffer with the given name and text and show it to the user. Use a file-like name (e.g. 'notes.md') so syntax highlighting applies. The buffer is not saved to disk.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, text: { type: "string" } },
      required: ["name", "text"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "open_file",
    description: "Open a file from disk into a buffer (like C-x C-f). Returns the buffer name. Relative paths resolve against the current buffer's directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_directory",
    description: "List the files in a directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "save_buffer",
    description: "Save a buffer to its file. Only when the user asked to save.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "run_shell",
    description: "Run a shell command on the user's machine (cmd.exe/PowerShell on Windows). The user is asked to confirm every call. Returns stdout, stderr and the exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        reason: { type: "string", description: "One sentence shown to the user explaining why." },
      },
      required: ["command", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export interface ToolOutcome {
  content: string;
  summary: string;
  isError: boolean;
}

const ok = (content: string, summary = content): ToolOutcome => ({ content, summary: clip(summary), isError: false });
const fail = (msg: string): ToolOutcome => ({ content: msg, summary: clip(`error: ${msg}`), isError: true });

function clip(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function targetBuffer(ed: Editor, name: unknown) {
  if (typeof name !== "string") return null;
  return ed.getBuffer(name) ?? ed.buffers.find((b) => b.filePath && b.filePath.replace(/\\/g, "/").endsWith(name.replace(/\\/g, "/"))) ?? null;
}

/** The buffer the user is working in, i.e. the current one unless that is the chat itself. */
function workBuffer(ed: Editor) {
  if (ed.buffer.name !== "*Claude*") return ed.buffer;
  return ed.windows.map((w) => w.buffer).find((b) => b.name !== "*Claude*") ?? ed.buffers.find((b) => b.name !== "*Claude*") ?? ed.buffer;
}

export async function executeTool(ed: Editor, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "list_buffers": {
        const cur = workBuffer(ed);
        const lines = ed.buffers.map(
          (b) => `${b === cur ? "* " : "  "}${b.name}\t${b.filePath ?? "(no file)"}\t${b.modeName}\t${b.doc.lines} lines${b.modified ? "\t[modified]" : ""}${b.readOnly ? "\t[read-only]" : ""}`,
        );
        return ok(lines.join("\n"), `${ed.buffers.length} buffers`);
      }
      case "read_buffer": {
        const b = targetBuffer(ed, input.name);
        if (!b) return fail(`No buffer named ${String(input.name)}`);
        const total = b.doc.lines;
        const start = Math.max(1, Number(input.start_line) || 1);
        const end = Math.min(total, Number(input.end_line) || total, start + 1999);
        const out: string[] = [];
        for (let i = start; i <= end; i++) out.push(`${String(i).padStart(5)}\t${b.doc.line(i).text}`);
        if (end < total) out.push(`... (${total - end} more lines; call again with start_line ${end + 1})`);
        return ok(out.join("\n"), `lines ${start}-${end} of ${total}`);
      }
      case "get_selection": {
        const b = workBuffer(ed);
        const win = ed.windows.find((w) => w.buffer === b);
        if (!win) return ok(`buffer: ${b.name}\n(not shown in a window)`);
        const st = win.view.state;
        const sel = st.selection.main;
        const line = st.doc.lineAt(sel.head);
        const region = sel.empty ? "" : st.sliceDoc(sel.from, sel.to);
        return ok(
          `buffer: ${b.name}\nfile: ${b.filePath ?? "(none)"}\npoint: line ${line.number}, column ${sel.head - line.from}\nregion: ${region ? `\n<region>\n${region}\n</region>` : "(none)"}`,
          region ? `${region.length} chars selected` : `point at line ${line.number}`,
        );
      }
      case "edit_buffer": {
        const b = targetBuffer(ed, input.name);
        if (!b) return fail(`No buffer named ${String(input.name)}`);
        if (b.readOnly) return fail(`${b.name} is read-only`);
        const oldText = String(input.old_text ?? "");
        const newText = String(input.new_text ?? "");
        if (!oldText) return fail("old_text must not be empty");
        const text = b.text;
        const first = text.indexOf(oldText);
        if (first < 0) return fail("old_text not found; read the buffer again and copy the text exactly");
        if (text.indexOf(oldText, first + 1) >= 0) return fail("old_text occurs more than once; include more surrounding context");
        ed.changeBuffer(b, { from: first, to: first + oldText.length, insert: newText });
        const win = ed.windows.find((w) => w.buffer === b);
        if (win) win.view.dispatch({ selection: EditorSelection.cursor(first + newText.length), scrollIntoView: true });
        const line = b.doc.lineAt(first).number;
        return ok(`Edited ${b.name} at line ${line}.`, `edited line ${line}`);
      }
      case "replace_buffer": {
        const b = targetBuffer(ed, input.name);
        if (!b) return fail(`No buffer named ${String(input.name)}`);
        if (b.readOnly) return fail(`${b.name} is read-only`);
        ed.setBufferText(b, String(input.text ?? ""), true);
        return ok(`Replaced contents of ${b.name} (${b.doc.lines} lines).`, `${b.doc.lines} lines`);
      }
      case "insert_at_point": {
        const b = workBuffer(ed);
        if (b.readOnly) return fail(`${b.name} is read-only`);
        const win = ed.windows.find((w) => w.buffer === b);
        const text = String(input.text ?? "");
        if (win) {
          const sel = win.view.state.selection.main;
          win.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: EditorSelection.cursor(sel.from + text.length), scrollIntoView: true });
        } else ed.appendToBuffer(b, text);
        return ok(`Inserted ${text.length} characters into ${b.name}.`);
      }
      case "create_buffer": {
        const b = ed.createBuffer(String(input.name || "untitled"), String(input.text ?? ""), "file");
        b.filePath = null;
        b.defaultDirectory = workBuffer(ed).defaultDirectory;
        const fake = b.name;
        b.filePath = fake; // only to detect the language from the name
        ed.detectLanguage(b);
        b.filePath = null;
        b.modified = true;
        ed.popToBuffer(b, false);
        return ok(`Created buffer ${b.name}.`);
      }
      case "open_file": {
        const base = workBuffer(ed).defaultDirectory ?? undefined;
        const p = await window.sumi.fs.resolve(String(input.path ?? ""), base);
        const st = await window.sumi.fs.stat(p);
        if (!st) return fail(`${p} does not exist`);
        if (st.isDirectory) return fail(`${p} is a directory; use list_directory`);
        const win = ed.windows.find((w) => w.buffer.name !== "*Claude*") ?? ed.current;
        const b = await ed.findFile(p, win);
        return ok(`Opened ${p} as buffer ${b.name} (${b.doc.lines} lines).`, b.name);
      }
      case "list_directory": {
        const base = workBuffer(ed).defaultDirectory ?? undefined;
        const p = await window.sumi.fs.resolve(String(input.path ?? "."), base);
        const res = await window.sumi.fs.readDir(p);
        if (!res.ok) return fail(res.error);
        return ok(res.entries.map((e) => `${e.isDirectory ? "d" : "-"}\t${e.size}\t${e.name}`).join("\n") || "(empty)", `${res.entries.length} entries`);
      }
      case "save_buffer": {
        const b = targetBuffer(ed, input.name);
        if (!b) return fail(`No buffer named ${String(input.name)}`);
        if (!b.filePath) return fail("Buffer has no file; ask the user to save it with C-x C-w");
        await ed.saveBuffer(b);
        return ok(`Saved ${b.filePath}`);
      }
      case "run_shell": {
        const command = String(input.command ?? "");
        const reason = String(input.reason ?? "");
        const yes = await ed.minibuffer.yesOrNo(`Claude wants to run: ${command}  [${reason}]`);
        if (!yes) return fail("The user declined to run the command");
        const res = await window.sumi.shell.run(command, workBuffer(ed).defaultDirectory);
        const out = `exit code: ${res.code}\nstdout:\n${res.stdout.slice(0, 20000)}\nstderr:\n${res.stderr.slice(0, 5000)}${res.error ? `\nerror: ${res.error}` : ""}`;
        return { content: out, summary: `exit ${res.code}`, isError: res.code !== 0 };
      }
      default:
        return fail(`Unknown tool ${name}`);
    }
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
