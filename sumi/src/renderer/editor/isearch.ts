import { EditorSelection } from "@codemirror/state";
import type { Editor } from "./editor";

/**
 * Emacs-style incremental search driven from the minibuffer.
 * C-s / C-r repeat, RET exits at the match, C-g returns to where you started.
 */
export async function isearch(ed: Editor, forward: boolean): Promise<void> {
  const view = ed.view;
  const origin = view.state.selection.main;
  let dir = forward;
  let query = "";
  let matchFrom = origin.head;
  let matchTo = origin.head;
  let failing = false;
  let wrapped = false;

  const promptText = () => `${failing ? "Failing " : ""}${wrapped ? "Wrapped " : ""}I-search${dir ? "" : " backward"}: `;
  const setPrompt = () => {
    const el = document.getElementById("mb-prompt");
    if (el) el.textContent = promptText();
  };

  const find = (q: string, from: number, fwd: boolean, allowWrap: boolean): [number, number] | null => {
    if (!q) return null;
    const doc = view.state.doc.toString();
    const smart = q === q.toLowerCase();
    const hay = smart ? doc.toLowerCase() : doc;
    const needle = smart ? q.toLowerCase() : q;
    let idx = fwd ? hay.indexOf(needle, from) : hay.lastIndexOf(needle, from);
    if (idx < 0 && allowWrap) {
      idx = fwd ? hay.indexOf(needle, 0) : hay.lastIndexOf(needle);
      if (idx >= 0) wrapped = true;
    }
    return idx < 0 ? null : [idx, idx + needle.length];
  };

  const show = (m: [number, number] | null) => {
    if (m) {
      failing = false;
      [matchFrom, matchTo] = m;
      view.dispatch({ selection: EditorSelection.range(matchFrom, matchTo), scrollIntoView: true });
    } else failing = true;
    setPrompt();
  };

  const search = (q: string, repeat: boolean) => {
    query = q;
    if (!q) {
      failing = false;
      view.dispatch({ selection: EditorSelection.cursor(origin.head) });
      setPrompt();
      return;
    }
    let start: number;
    if (repeat) start = dir ? matchTo : matchFrom - 1;
    else start = dir ? Math.min(matchFrom, origin.head) : Math.max(matchTo, origin.head);
    if (!repeat && !dir) start = Math.max(origin.head - q.length, 0) + q.length;
    show(find(q, start, dir, repeat));
  };

  const result = await ed.minibuffer.read({
    prompt: promptText(),
    history: "isearch",
    onChange: (q) => search(q, false),
    keys: {
      "C-s": (mb) => {
        if (!dir) {
          dir = true;
          setPrompt();
        }
        if (!mb.value && lastSearch) mb.setValue(lastSearch);
        else search(mb.value, true);
        return true;
      },
      "C-r": (mb) => {
        if (dir) {
          dir = false;
          setPrompt();
        }
        if (!mb.value && lastSearch) mb.setValue(lastSearch);
        else search(mb.value, true);
        return true;
      },
      "C-w": (mb) => {
        // Yank the word after point into the search string, like Emacs.
        const doc = view.state.doc;
        const from = matchTo;
        const line = doc.lineAt(from);
        const m = /^\s*\S+/.exec(line.text.slice(from - line.from));
        if (m) mb.setValue(mb.value + m[0]);
        return true;
      },
      "M-%": () => false,
    },
  });

  if (result === null) {
    view.dispatch({ selection: origin, scrollIntoView: true });
    ed.echo("Quit");
    return;
  }
  if (query) lastSearch = query;
  if (!failing && query) {
    // Leave point at the end of the match with the match as the active region (mark at start).
    view.dispatch({ selection: EditorSelection.range(matchFrom, matchTo) });
    ed.echo("Mark saved where search started");
  } else {
    view.dispatch({ selection: EditorSelection.cursor(origin.head) });
  }
}

let lastSearch = "";
