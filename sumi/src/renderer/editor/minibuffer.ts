import { keyName } from "./keys";

export type CompletionSource = (input: string) => string[] | Promise<string[]>;

export interface ReadOptions {
  prompt: string;
  initial?: string;
  completions?: CompletionSource;
  /** Only accept one of the candidates (M-x style). */
  requireMatch?: boolean;
  /** Shown as "(default X)" and returned on empty input. */
  defaultValue?: string;
  password?: boolean;
  /** History ring name. */
  history?: string;
  /** Called on every change of the input (incremental search). */
  onChange?: (input: string) => void;
  /** Extra key handlers; return true to stop further handling. */
  keys?: Record<string, (mb: Minibuffer) => boolean | void>;
  /** Pre-select the first candidate so RET picks it. Default: requireMatch. */
  selectFirst?: boolean;
}

interface Session {
  opts: ReadOptions;
  resolve: (v: string | null) => void;
  candidates: string[];
  selected: number;
  historyIndex: number;
  savedInput: string;
}

/** Builds a completion source over a fixed list: prefix matches first, then substring matches. */
export function completeFrom(items: (() => string[]) | string[]): CompletionSource {
  return (input) => {
    const list = typeof items === "function" ? items() : items;
    const q = input.toLowerCase();
    if (!q) return list;
    const starts = list.filter((s) => s.toLowerCase().startsWith(q));
    const contains = list.filter((s) => !s.toLowerCase().startsWith(q) && s.toLowerCase().includes(q));
    return [...starts, ...contains];
  };
}

/**
 * The minibuffer / echo area at the bottom of the frame.
 * Uses a native <input> so Japanese IME works, and lays a vertical completion list above it.
 */
export class Minibuffer {
  private readonly promptEl: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly echoEl: HTMLElement;
  private readonly completionsEl: HTMLElement;
  private session: Session | null = null;
  private histories = new Map<string, string[]>();
  private echoTimer: number | null = null;
  private seq = 0;

  constructor(root: HTMLElement) {
    this.completionsEl = root.querySelector("#completions")!;
    this.promptEl = root.querySelector("#mb-prompt")!;
    this.input = root.querySelector("#mb-input")!;
    this.echoEl = root.querySelector("#echo")!;
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("blur", () => {
      // Keep focus in the minibuffer while a read is active (clicks on the editor abort instead).
      if (this.session) setTimeout(() => this.session && this.input.focus(), 0);
    });
  }

  get active(): boolean {
    return this.session !== null;
  }

  get value(): string {
    return this.input.value;
  }

  setValue(v: string): void {
    this.input.value = v;
    this.onInput();
  }

  echo(text: string, sticky = false): void {
    this.echoEl.textContent = text;
    this.echoEl.classList.toggle("has-text", text.length > 0);
    if (this.echoTimer) window.clearTimeout(this.echoTimer);
    this.echoTimer = null;
    if (!sticky && text) {
      this.echoTimer = window.setTimeout(() => {
        this.echoEl.textContent = "";
        this.echoEl.classList.remove("has-text");
      }, 6000);
    }
  }

  clearEcho(): void {
    this.echo("");
  }

  read(opts: ReadOptions): Promise<string | null> {
    if (this.session) this.abort();
    return new Promise((resolve) => {
      const hist = this.histories.get(opts.history ?? "") ?? [];
      this.session = {
        opts,
        resolve,
        candidates: [],
        selected: opts.selectFirst ?? opts.requireMatch ? 0 : -1,
        historyIndex: hist.length,
        savedInput: "",
      };
      this.promptEl.textContent = opts.defaultValue ? `${opts.prompt.replace(/:\s*$/, "")} (default ${opts.defaultValue}): ` : opts.prompt;
      this.input.type = opts.password ? "password" : "text";
      this.input.value = opts.initial ?? "";
      this.echoEl.textContent = "";
      this.echoEl.classList.remove("has-text");
      document.body.classList.add("minibuffer-active");
      this.input.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      void this.refreshCandidates();
    });
  }

  /** Simple y/n confirmation. */
  async yesOrNo(prompt: string): Promise<boolean> {
    const answer = await this.read({
      prompt: `${prompt} (y or n) `,
      keys: {
        y: (mb) => {
          mb.finish("y");
          return true;
        },
        n: (mb) => {
          mb.finish("n");
          return true;
        },
        RET: () => true,
      },
    });
    return answer === "y";
  }

  finish(value: string): void {
    const s = this.session;
    if (!s) return;
    if (s.opts.history && value) {
      const h = this.histories.get(s.opts.history) ?? [];
      if (h[h.length - 1] !== value) h.push(value);
      this.histories.set(s.opts.history, h);
    }
    this.close();
    s.resolve(value);
  }

  abort(): void {
    const s = this.session;
    if (!s) return;
    this.close();
    s.resolve(null);
  }

  private close(): void {
    this.session = null;
    this.promptEl.textContent = "";
    this.input.value = "";
    this.input.type = "text";
    this.completionsEl.innerHTML = "";
    this.completionsEl.classList.remove("open");
    document.body.classList.remove("minibuffer-active");
    this.input.blur();
  }

  private onInput(): void {
    const s = this.session;
    if (!s) return;
    s.opts.onChange?.(this.input.value);
    void this.refreshCandidates();
  }

  private async refreshCandidates(): Promise<void> {
    const s = this.session;
    if (!s?.opts.completions) return;
    const my = ++this.seq;
    let list: string[];
    try {
      list = await s.opts.completions(this.input.value);
    } catch {
      list = [];
    }
    if (my !== this.seq || this.session !== s) return;
    s.candidates = list;
    s.selected = Math.min(s.selected, list.length - 1);
    if ((s.opts.selectFirst ?? s.opts.requireMatch) && list.length && s.selected < 0) s.selected = 0;
    this.renderCandidates();
  }

  private renderCandidates(): void {
    const s = this.session;
    if (!s) return;
    const list = s.candidates;
    this.completionsEl.innerHTML = "";
    if (!list.length) {
      this.completionsEl.classList.remove("open");
      return;
    }
    this.completionsEl.classList.add("open");
    const max = 14;
    let start = 0;
    if (s.selected >= max) start = s.selected - max + 1;
    const shown = list.slice(start, start + max);
    shown.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "cand" + (start + i === s.selected ? " sel" : "");
      item.textContent = c;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.finish(c);
      });
      this.completionsEl.append(item);
    });
    if (list.length > shown.length) {
      const more = document.createElement("div");
      more.className = "cand more";
      more.textContent = `… ${list.length - shown.length} more (${list.length} total)`;
      this.completionsEl.append(more);
    }
  }

  private moveSelection(delta: number): void {
    const s = this.session;
    if (!s || !s.candidates.length) return;
    s.selected = (s.selected + delta + s.candidates.length) % s.candidates.length;
    this.renderCandidates();
  }

  private complete(): void {
    const s = this.session;
    if (!s) return;
    if (!s.candidates.length) {
      this.echo("[No match]");
      return;
    }
    if (s.candidates.length === 1) {
      this.setValue(s.candidates[0]);
      return;
    }
    const prefix = commonPrefix(s.candidates);
    if (prefix.length > this.input.value.length && prefix.toLowerCase().startsWith(this.input.value.toLowerCase())) {
      this.setValue(prefix);
    } else if (s.selected >= 0) {
      this.moveSelection(1);
    } else {
      s.selected = 0;
      this.renderCandidates();
    }
  }

  private accept(): void {
    const s = this.session;
    if (!s) return;
    const raw = this.input.value;
    if (s.opts.requireMatch) {
      if (s.selected >= 0 && s.candidates[s.selected]) return this.finish(s.candidates[s.selected]);
      const exact = s.candidates.find((c) => c === raw);
      if (exact) return this.finish(exact);
      if (!raw && s.opts.defaultValue) return this.finish(s.opts.defaultValue);
      this.echo("[No match]");
      return;
    }
    if (!raw && s.opts.defaultValue) return this.finish(s.opts.defaultValue);
    if (s.selected >= 0 && s.candidates[s.selected] && (s.opts.selectFirst || raw)) {
      // A candidate was navigated to or pre-selected.
      if (s.opts.selectFirst || s.candidates[s.selected] !== raw) return this.finish(s.candidates[s.selected]);
    }
    this.finish(raw);
  }

  private historyMove(delta: number): void {
    const s = this.session;
    if (!s || !s.opts.history) return;
    const h = this.histories.get(s.opts.history) ?? [];
    if (!h.length) return;
    if (s.historyIndex === h.length) s.savedInput = this.input.value;
    s.historyIndex = Math.max(0, Math.min(h.length, s.historyIndex + delta));
    this.setValue(s.historyIndex === h.length ? s.savedInput : h[s.historyIndex]);
  }

  /** Inserts text as if typed (used when replaying keyboard macros / tests, where native typing doesn't happen). */
  insertText(text: string): void {
    const el = this.input;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, "end");
    this.onInput();
  }

  /**
   * Handles a keydown while the minibuffer is active.
   * Returns true when the event was consumed (caller must preventDefault).
   */
  handleKey(e: KeyboardEvent, synthetic: boolean): boolean {
    const s = this.session;
    if (!s) return false;
    const name = keyName(e);
    if (!name) return false;
    const custom = s.opts.keys?.[name];
    if (custom && custom(this) === true) return true;
    const el = this.input;
    const pos = el.selectionStart ?? 0;
    switch (name) {
      case "RET":
        this.accept();
        return true;
      case "C-g":
        this.abort();
        return true;
      case "TAB":
        this.complete();
        return true;
      case "<down>":
      case "C-n":
        this.moveSelection(1);
        return true;
      case "<up>":
      case "C-p":
        this.moveSelection(-1);
        return true;
      case "M-p":
        this.historyMove(-1);
        return true;
      case "M-n":
        this.historyMove(1);
        return true;
      case "C-a":
        el.setSelectionRange(0, 0);
        return true;
      case "C-e":
        el.setSelectionRange(el.value.length, el.value.length);
        return true;
      case "C-b":
        el.setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1));
        return true;
      case "C-f":
        el.setSelectionRange(Math.min(el.value.length, pos + 1), Math.min(el.value.length, pos + 1));
        return true;
      case "C-k":
        el.setRangeText("", pos, el.value.length, "end");
        this.onInput();
        return true;
      case "C-d":
        if (pos < el.value.length) el.setRangeText("", pos, pos + 1, "end");
        this.onInput();
        return true;
      case "M-DEL":
      case "C-DEL":
      case "C-w": {
        const before = el.value.slice(0, pos);
        const m = /[^\s\\/]*[\s\\/]*$/.exec(before);
        const cut = m ? m[0].length : 0;
        el.setRangeText("", pos - cut, pos, "end");
        this.onInput();
        return true;
      }
      case "M-x":
      case "C-x":
      case "C-c":
        return true; // swallow prefix keys inside the minibuffer
    }
    if (synthetic) {
      if (name === "DEL") {
        if (pos > 0) el.setRangeText("", pos - 1, pos, "end");
        this.onInput();
        return true;
      }
      if (name.length === 1) {
        this.insertText(name);
        return true;
      }
      if (name === "SPC") {
        this.insertText(" ");
        return true;
      }
    }
    return false; // let the native input handle typing, Backspace, arrows, etc.
  }
}

function commonPrefix(list: string[]): string {
  if (!list.length) return "";
  let p = list[0];
  for (const s of list) {
    let i = 0;
    while (i < p.length && i < s.length && p[i].toLowerCase() === s[i].toLowerCase()) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}
