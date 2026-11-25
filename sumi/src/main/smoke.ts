import { app, type BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Headless smoke test (`electron . --smoke`, with SUMI_FAKE_CLAUDE=1): drives the editor
 * through its key dispatcher, checks the results and writes a screenshot.
 */
export async function runSmoke(win: BrowserWindow): Promise<void> {
  const wc = win.webContents;
  const log = (m: string) => process.stdout.write(`[smoke] ${m}\n`);
  let failed = false;
  try {
    await wc.executeJavaScript(`new Promise((r) => { const t = setInterval(() => { if (window.__sumiReady) { clearInterval(t); r(true); } }, 20); })`);
    log("renderer ready");
    const script = process.env.SUMI_SMOKE_SCRIPT ? await fs.readFile(process.env.SUMI_SMOKE_SCRIPT, "utf8") : SCRIPT;
    wc.on("console-message", (ev) => {
      if (ev.level === "error") log(`renderer console: ${ev.message}`);
    });
    const wrapped = `(async () => { try { return await (${script}); } catch (e) { return { "script threw": String(e && e.stack || e) }; } })()`;
    const results: Record<string, unknown> = await wc.executeJavaScript(wrapped, true);
    for (const [name, value] of Object.entries(results)) {
      const ok = value === true;
      if (!ok) failed = true;
      log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ": " + JSON.stringify(value)}`);
    }
    const shotDir = process.env.SUMI_SMOKE_DIR ?? path.join(process.cwd(), "smoke-out");
    await fs.mkdir(shotDir, { recursive: true });
    const img = await wc.capturePage();
    await fs.writeFile(path.join(shotDir, "sumi-smoke.png"), img.toPNG());
    log(`screenshot written to ${path.join(shotDir, "sumi-smoke.png")}`);
  } catch (err) {
    failed = true;
    log(`ERROR ${(err as Error).stack ?? err}`);
  }
  log(failed ? "SMOKE FAILED" : "SMOKE OK");
  app.exit(failed ? 1 : 0);
}

const SCRIPT = `(async () => {
  const ed = window.editor;
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, cond, info) => { out[name] = cond ? true : (info ?? false); };
  const typeText = (s) => { for (const ch of s) ed.feedKey(ch === " " ? "SPC" : ch); };
  const waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

  // 1. typing into *scratch* through the Emacs layer
  ed.feedKeys("M-> RET");
  typeText("hello sumi");
  ed.feedKeys("RET");
  typeText("second line foo");
  check("typing", ed.buffer.text.includes("hello sumi\\nsecond line foo"), ed.buffer.text);
  ed.feedKeys("C-a");
  check("C-a moves to line start", ed.view.state.selection.main.head === ed.view.state.doc.lineAt(ed.view.state.selection.main.head).from);
  ed.feedKeys("C-k");
  check("C-k kills line", !ed.buffer.text.includes("second line foo"));
  ed.feedKeys("C-y");
  check("C-y yanks", ed.buffer.text.includes("second line foo"));

  // 2. windows
  ed.feedKeys("C-x 2");
  check("C-x 2 splits", ed.windows.length === 2, ed.windows.length);
  ed.feedKeys("C-x 3");
  check("C-x 3 splits", ed.windows.length === 3, ed.windows.length);
  ed.feedKeys("C-x o");
  ed.feedKeys("C-x 0");
  check("C-x 0 deletes", ed.windows.length === 2, ed.windows.length);
  ed.feedKeys("C-x 1");
  check("C-x 1 keeps one", ed.windows.length === 1, ed.windows.length);

  // 3. M-x + minibuffer completion
  ed.feedKeys("M-x");
  check("M-x opens minibuffer", ed.minibuffer.active);
  typeText("goto-li");
  await sleep(30);
  ed.feedKeys("RET");
  await sleep(30);
  check("M-x goto-line prompts", ed.minibuffer.active && document.getElementById("mb-prompt").textContent.startsWith("Goto line"), document.getElementById("mb-prompt").textContent);
  typeText("1");
  ed.feedKeys("RET");
  await sleep(30);
  check("goto-line 1", ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number === 1);

  // 4. isearch
  ed.feedKeys("C-s");
  typeText("foo");
  await sleep(30);
  const sel = ed.view.state.selection.main;
  check("isearch selects match", ed.view.state.sliceDoc(sel.from, sel.to) === "foo", ed.view.state.sliceDoc(sel.from, sel.to));
  ed.feedKeys("RET");
  check("isearch exits", !ed.minibuffer.active);

  // 5. buffers
  ed.feedKeys("C-x b");
  typeText("notes.md");
  ed.feedKeys("RET");
  await sleep(30);
  check("C-x b creates buffer", ed.buffer.name === "notes.md", ed.buffer.name);
  typeText("# Title");
  ed.feedKeys("C-x C-b");
  await sleep(30);
  check("C-x C-b buffer list", ed.buffer.name === "*Buffer List*" && ed.buffer.text.includes("notes.md"), ed.buffer.name);
  ed.feedKeys("q");
  check("q quits window", ed.buffer.name !== "*Buffer List*", ed.buffer.name);

  // 6. keyboard macro
  ed.feedKeys("C-x b");
  typeText("*scratch*");
  ed.feedKeys("RET");
  await sleep(30);
  ed.feedKeys("M->");
  ed.feedKeys("C-x (");
  typeText("ab");
  ed.feedKeys("C-x )");
  ed.feedKeys("C-x e");
  await sleep(100);
  check("kbd macro replays", ed.buffer.text.endsWith("abab"), ed.buffer.text.slice(-10));

  // 7. eval
  ed.feedKeys("M-:");
  typeText("1+2");
  ed.feedKeys("RET");
  await sleep(50);
  check("M-: evaluates", document.getElementById("echo").textContent === "3", document.getElementById("echo").textContent);

  // 8. Claude chat with the fake backend (tool call + text)
  ed.feedKeys("C-c c");
  await sleep(50);
  check("C-c c opens *Claude*", ed.buffer.name === "*Claude*", ed.buffer.name);
  typeText("hi");
  ed.feedKeys("C-c C-c");
  const done = await waitFor(() => ed.buffer.text.includes("こんにちは！ Sumi から Claude です。") && ed.buffer.text.trimEnd().endsWith("### You"), 8000);
  check("claude streams reply", done, ed.buffer.text.slice(-400));
  check("claude tool loop ran list_buffers", ed.buffer.text.includes("⚙ list_buffers") && ed.buffer.text.includes("buffers"), ed.buffer.text.slice(-400));
  const chat = ed.buffer.meta.chat;
  check("conversation history kept", chat && chat.messages.length === 4 && chat.messages[3].role === "assistant", chat && chat.messages.map((m) => m.role));

  // 9. files: find-file, save, dired through the IPC bridge
  const tmpDir = await window.sumi.fs.resolve("sumi-smoke-tmp", await window.sumi.fs.cwd());
  const tmpFile = tmpDir + "/probe.ts";
  await window.sumi.fs.writeFile(tmpFile, "export const answer = 42;\\n");
  ed.feedKeys("C-x C-f");
  await sleep(50);
  ed.minibuffer.setValue(tmpFile);
  await sleep(50);
  ed.feedKeys("RET");
  const opened = await waitFor(() => ed.buffer.name === "probe.ts" && ed.buffer.text.includes("answer = 42"));
  check("C-x C-f opens file", opened, ed.buffer.name);
  check("language detected", ed.buffer.modeName === "TypeScript", ed.buffer.modeName);
  ed.feedKeys("M->");
  typeText("// edited");
  check("buffer marked modified", ed.buffer.modified === true);
  ed.feedKeys("C-x C-s");
  const saved = await waitFor(() => ed.buffer.modified === false);
  const onDisk = await window.sumi.fs.readFile(tmpFile);
  check("C-x C-s writes file", saved && onDisk.ok && onDisk.text.includes("// edited"), onDisk);
  ed.feedKeys("C-x d");
  await sleep(50);
  ed.minibuffer.setValue(tmpDir);
  ed.feedKeys("RET");
  const dired = await waitFor(() => ed.buffer.modeName === "Dired" && ed.buffer.text.includes("probe.ts"));
  check("C-x d dired lists directory", dired, ed.buffer.name + " " + ed.buffer.text.slice(0, 200));
  ed.feedKeys("q");

  // 10. help
  ed.feedKeys("C-h b");
  await sleep(30);
  check("C-h b help", ed.buffer.name === "*Help*" && ed.buffer.text.includes("find-file"), ed.buffer.name);
  ed.feedKeys("q");
  ed.feedKeys("C-x 1");
  ed.feedKeys("C-x b");
  typeText("*Claude*");
  ed.feedKeys("RET");
  await sleep(30);
  ed.feedKeys("C-x 3");
  ed.feedKeys("C-x b");
  typeText("*scratch*");
  ed.feedKeys("RET");
  await sleep(100);
  return out;
})()`;
