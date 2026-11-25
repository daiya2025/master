import { EditorSelection, Text, type EditorState } from "@codemirror/state";
import type { LanguageDescription } from "@codemirror/language";
import type { Keymap } from "./keys";

export type BufferKind = "file" | "scratch" | "special";

let nextId = 1;

/**
 * An Emacs buffer: text plus metadata. Views (windows) render a buffer; the buffer
 * keeps the canonical document so several windows can show it at once.
 */
export class Buffer {
  readonly id = nextId++;
  doc: Text;
  modified = false;
  filePath: string | null = null;
  /** The directory used as default for find-file etc. */
  defaultDirectory: string | null = null;
  readOnly = false;
  /** Buffer-local keymap, consulted before the global one. */
  localKeymap: Keymap | null = null;
  /** Shown in the mode line as the major mode. */
  modeName = "Fundamental";
  language: LanguageDescription | null = null;
  /** Last known point, restored when the buffer is shown in a window again. */
  savedSelection = EditorSelection.single(0);
  /** Free-form state for special buffers (dired path, chat history...). */
  meta: Record<string, unknown> = {};
  /** Hooks invoked when the buffer is killed. */
  onKill: (() => void)[] = [];

  constructor(
    public name: string,
    text = "",
    readonly kind: BufferKind = "file",
  ) {
    this.doc = Text.of(text.split(/\r?\n/));
  }

  get text(): string {
    return this.doc.toString();
  }

  /** Syncs the canonical doc from a view state after it changed. */
  syncFrom(state: EditorState): void {
    this.doc = state.doc;
  }

  setText(text: string): void {
    this.doc = Text.of(text.split(/\r?\n/));
  }
}
