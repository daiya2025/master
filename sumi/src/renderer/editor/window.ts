import { Annotation, Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { history, indentSelection, insertNewlineAndIndent, insertTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { acceptCompletion, autocompletion, closeCompletion, moveCompletionSelection } from "@codemirror/autocomplete";
import { emacs } from "@replit/codemirror-emacs";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Buffer } from "./buffer";

/** Marks transactions that mirror a change made in another window of the same buffer. */
export const syncAnnotation = Annotation.define<boolean>();

export interface WindowHost {
  onViewUpdate(win: EditorWindow, update: ViewUpdate): void;
  onWindowFocus(win: EditorWindow): void;
  settings: { theme: "dark" | "light"; fontSize: number };
  lineNumbersEnabled: boolean;
  wrapEnabled: boolean;
}

const lightTheme = EditorView.theme({}, { dark: false });

/**
 * An Emacs window: one CodeMirror view plus a mode line, showing exactly one buffer.
 */
export class EditorWindow {
  readonly el: HTMLElement;
  readonly modeline: HTMLElement;
  readonly view: EditorView;
  buffer!: Buffer;
  prevBuffer: Buffer | null = null;
  private readonly langCompartment = new Compartment();
  private readonly themeCompartment = new Compartment();
  private readonly lineNoCompartment = new Compartment();
  private readonly wrapCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();
  private loadedLangFor: Buffer | null = null;

  constructor(
    private readonly host: WindowHost,
    buffer: Buffer,
  ) {
    this.el = document.createElement("div");
    this.el.className = "sumi-window";
    const viewHolder = document.createElement("div");
    viewHolder.className = "sumi-view";
    this.modeline = document.createElement("div");
    this.modeline.className = "sumi-modeline";
    this.el.append(viewHolder, this.modeline);

    this.view = new EditorView({
      state: this.makeState(buffer),
      parent: viewHolder,
    });
    this.view.contentDOM.addEventListener("focus", () => this.host.onWindowFocus(this));
    this.el.addEventListener("mousedown", () => this.host.onWindowFocus(this));
    this.buffer = buffer;
    void this.loadLanguage(buffer);
    this.updateModeline(false);
  }

  private baseExtensions(buffer: Buffer): Extension {
    return [
      this.lineNoCompartment.of(this.host.lineNumbersEnabled ? lineNumbers() : []),
      this.wrapCompartment.of(this.host.wrapEnabled ? EditorView.lineWrapping : []),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      bracketMatching(),
      indentOnInput(),
      rectangularSelection(),
      autocompletion({ activateOnTyping: false }),
      emacs(),
      // No defaultKeymap: its Mod-a / Mod-z bindings would shadow the Emacs layer.
      // Completion popup keys win while a popup is open; they return false otherwise.
      Prec.highest(
        keymap.of([
          { key: "Enter", run: acceptCompletion },
          { key: "Escape", run: closeCompletion },
          { key: "ArrowDown", run: moveCompletionSelection(true) },
          { key: "ArrowUp", run: moveCompletionSelection(false) },
        ]),
      ),
      keymap.of([
        // The Emacs layer leaves RET to the browser; bind it so newlines indent like Emacs' electric-indent.
        { key: "Enter", run: insertNewlineAndIndent },
        {
          key: "Tab",
          run: (v) => {
            // Emacs-style TAB: re-indent the line when the language knows how, otherwise insert a tab.
            const before = v.state.doc;
            indentSelection(v);
            return v.state.doc === before ? insertTab(v) : true;
          },
        },
      ]),
      this.themeCompartment.of(this.host.settings.theme === "dark" ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle)]),
      this.langCompartment.of([]),
      this.readOnlyCompartment.of(EditorState.readOnly.of(buffer.readOnly)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged || u.selectionSet) this.host.onViewUpdate(this, u);
      }),
    ];
  }

  private makeState(buffer: Buffer): EditorState {
    const sel = buffer.savedSelection;
    const max = buffer.doc.length;
    const clamped = sel.main.from <= max && sel.main.to <= max ? sel : undefined;
    return EditorState.create({ doc: buffer.doc, extensions: this.baseExtensions(buffer), selection: clamped });
  }

  /** Switches this window to show another buffer, remembering point in the old one. */
  showBuffer(buffer: Buffer): void {
    if (buffer === this.buffer) return;
    this.buffer.savedSelection = this.view.state.selection;
    this.prevBuffer = this.buffer;
    this.buffer = buffer;
    this.view.setState(this.makeState(buffer));
    void this.loadLanguage(buffer);
    this.updateModeline(true);
  }

  async loadLanguage(buffer: Buffer): Promise<void> {
    if (!buffer.language) {
      this.view.dispatch({ effects: this.langCompartment.reconfigure([]) });
      return;
    }
    const desc = buffer.language;
    this.loadedLangFor = buffer;
    let support: LanguageSupport;
    try {
      support = desc.support ?? (await desc.load());
    } catch {
      return;
    }
    if (this.buffer !== buffer || this.loadedLangFor !== buffer) return;
    this.view.dispatch({ effects: this.langCompartment.reconfigure(support) });
  }

  setReadOnly(ro: boolean): void {
    this.view.dispatch({ effects: this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)) });
  }

  applyTheme(theme: "dark" | "light"): void {
    this.view.dispatch({
      effects: this.themeCompartment.reconfigure(theme === "dark" ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle)]),
    });
  }

  setLineNumbers(on: boolean): void {
    this.view.dispatch({ effects: this.lineNoCompartment.reconfigure(on ? lineNumbers() : []) });
  }

  setWrap(on: boolean): void {
    this.view.dispatch({ effects: this.wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.buffer.savedSelection = this.view.state.selection;
    this.view.destroy();
    this.el.remove();
  }

  updateModeline(active: boolean): void {
    const st = this.view.state;
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    const col = head - line.from;
    const total = st.doc.lines;
    let pos: string;
    if (total <= 1) pos = "All";
    else {
      const pct = Math.round(((line.number - 1) / Math.max(1, total - 1)) * 100);
      pos = line.number === 1 ? "Top" : line.number === total ? "Bot" : `${pct}%`;
    }
    const flag = this.buffer.readOnly ? "%%" : this.buffer.modified ? "**" : "--";
    const extra = (this.buffer.meta.modelineExtra as string | undefined) ?? "";
    this.modeline.classList.toggle("active", active);
    this.modeline.innerHTML = "";
    const left = document.createElement("span");
    left.className = "ml-left";
    left.textContent = `-${flag}-  ${this.buffer.name}`;
    const right = document.createElement("span");
    right.className = "ml-right";
    right.textContent = `${extra}L${line.number} C${col}  ${pos}  (${this.buffer.modeName})`;
    this.modeline.append(left, right);
  }
}

export type LayoutNode =
  | { kind: "leaf"; win: EditorWindow }
  | { kind: "split"; dir: "row" | "column"; children: LayoutNode[] };

/** The window tree of the single frame, rendered with nested flex containers. */
export class Layout {
  root: LayoutNode;

  constructor(
    private readonly container: HTMLElement,
    first: EditorWindow,
  ) {
    this.root = { kind: "leaf", win: first };
    this.render();
  }

  windows(): EditorWindow[] {
    const out: EditorWindow[] = [];
    const walk = (n: LayoutNode) => {
      if (n.kind === "leaf") out.push(n.win);
      else n.children.forEach(walk);
    };
    walk(this.root);
    return out;
  }

  private parentOf(target: LayoutNode, node: LayoutNode = this.root): Extract<LayoutNode, { kind: "split" }> | null {
    if (node.kind !== "split") return null;
    for (const c of node.children) {
      if (c === target) return node;
      const p = this.parentOf(target, c);
      if (p) return p;
    }
    return null;
  }

  private leafOf(win: EditorWindow, node: LayoutNode = this.root): LayoutNode | null {
    if (node.kind === "leaf") return node.win === win ? node : null;
    for (const c of node.children) {
      const l = this.leafOf(win, c);
      if (l) return l;
    }
    return null;
  }

  split(win: EditorWindow, dir: "row" | "column", newWin: EditorWindow): void {
    const leaf = this.leafOf(win);
    if (!leaf) return;
    const parent = this.parentOf(leaf);
    const newLeaf: LayoutNode = { kind: "leaf", win: newWin };
    if (parent && parent.dir === dir) {
      parent.children.splice(parent.children.indexOf(leaf) + 1, 0, newLeaf);
    } else {
      const split: LayoutNode = { kind: "split", dir, children: [leaf, newLeaf] };
      if (parent) parent.children[parent.children.indexOf(leaf)] = split;
      else this.root = split;
    }
    this.render();
  }

  remove(win: EditorWindow): boolean {
    const leaf = this.leafOf(win);
    if (!leaf) return false;
    const parent = this.parentOf(leaf);
    if (!parent) return false; // sole window
    parent.children.splice(parent.children.indexOf(leaf), 1);
    if (parent.children.length === 1) {
      const only = parent.children[0];
      const grand = this.parentOf(parent);
      if (grand) grand.children[grand.children.indexOf(parent)] = only;
      else this.root = only;
    }
    this.render();
    return true;
  }

  keepOnly(win: EditorWindow): void {
    this.root = { kind: "leaf", win };
    this.render();
  }

  render(): void {
    const build = (n: LayoutNode): HTMLElement => {
      if (n.kind === "leaf") return n.win.el;
      const el = document.createElement("div");
      el.className = `sumi-split ${n.dir}`;
      for (const c of n.children) el.append(build(c));
      return el;
    };
    this.container.replaceChildren(build(this.root));
    for (const w of this.windows()) w.view.requestMeasure();
  }
}
