// Key naming in Emacs notation ("C-x C-f", "M-x", "RET", "<f5>") and keymap lookup.

const SPECIAL: Record<string, string> = {
  Enter: "RET",
  Tab: "TAB",
  Escape: "ESC",
  Backspace: "DEL",
  " ": "SPC",
  Delete: "<delete>",
  ArrowUp: "<up>",
  ArrowDown: "<down>",
  ArrowLeft: "<left>",
  ArrowRight: "<right>",
  Home: "<home>",
  End: "<end>",
  PageUp: "<prior>",
  PageDown: "<next>",
  Insert: "<insert>",
};

const IGNORED = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "OS", "Hyper", "Super"]);

/** Converts a KeyboardEvent to an Emacs-style key name, or null for events we never bind. */
export function keyName(e: KeyboardEvent): string | null {
  if (IGNORED.has(e.key)) return null;
  if (e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") return null;
  let base: string;
  if (SPECIAL[e.key]) base = SPECIAL[e.key];
  else if (/^F\d{1,2}$/.test(e.key)) base = `<${e.key.toLowerCase()}>`;
  else if (e.key.length === 1) base = e.key;
  else base = `<${e.key.toLowerCase()}>`;
  // Ctrl+letter arrives as a lowercase letter unless Shift is held; keep letters lowercase for C-/M- combos.
  if (base.length === 1 && (e.ctrlKey || e.altKey) && !e.shiftKey) base = base.toLowerCase();
  let mods = "";
  if (e.ctrlKey) mods += "C-";
  if (e.altKey) mods += "M-";
  if (e.shiftKey && base.length > 1) mods += "S-";
  return mods + base;
}

const CODE_FOR: Record<string, string> = {
  " ": "Space",
  "/": "Slash",
  "-": "Minus",
  "=": "Equal",
  ".": "Period",
  ",": "Comma",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "`": "Backquote",
  "_": "Minus",
  "+": "Equal",
  "%": "Digit5",
  "@": "Digit2",
  "<": "Comma",
  ">": "Period",
  "?": "Slash",
  ":": "Semicolon",
  "!": "Digit1",
  "|": "Backslash",
};

/** Characters that need Shift on a US layout; the Emacs layer keys off e.code + shiftKey. */
const SHIFTED = "~!@#$%^&*()_+{}|:\"<>?";

const KEY_FOR_SPECIAL: Record<string, [string, string]> = {
  RET: ["Enter", "Enter"],
  TAB: ["Tab", "Tab"],
  ESC: ["Escape", "Escape"],
  DEL: ["Backspace", "Backspace"],
  SPC: [" ", "Space"],
  "<delete>": ["Delete", "Delete"],
  "<up>": ["ArrowUp", "ArrowUp"],
  "<down>": ["ArrowDown", "ArrowDown"],
  "<left>": ["ArrowLeft", "ArrowLeft"],
  "<right>": ["ArrowRight", "ArrowRight"],
  "<home>": ["Home", "Home"],
  "<end>": ["End", "End"],
  "<prior>": ["PageUp", "PageUp"],
  "<next>": ["PageDown", "PageDown"],
};

/** Builds a synthetic KeyboardEvent for an Emacs key name, for replaying into CodeMirror. */
export function eventForKey(name: string): KeyboardEvent {
  let rest = name;
  const init: KeyboardEventInit = { bubbles: true, cancelable: true };
  for (;;) {
    if (rest.startsWith("C-") && rest.length > 2) {
      init.ctrlKey = true;
      rest = rest.slice(2);
    } else if (rest.startsWith("M-") && rest.length > 2) {
      init.altKey = true;
      rest = rest.slice(2);
    } else if (rest.startsWith("S-") && rest.length > 2) {
      init.shiftKey = true;
      rest = rest.slice(2);
    } else break;
  }
  if (KEY_FOR_SPECIAL[rest]) {
    [init.key, init.code] = KEY_FOR_SPECIAL[rest];
  } else if (rest.length === 1) {
    init.key = rest;
    if (/[a-zA-Z]/.test(rest)) {
      init.code = "Key" + rest.toUpperCase();
      if (rest !== rest.toLowerCase()) init.shiftKey = true;
    } else if (/[0-9]/.test(rest)) init.code = "Digit" + rest;
    else {
      init.code = CODE_FOR[rest] ?? "Unidentified";
      if (SHIFTED.includes(rest)) init.shiftKey = true;
    }
  } else {
    init.key = rest.replace(/^<|>$/g, "");
    init.code = init.key;
  }
  const ev = new KeyboardEvent("keydown", init);
  (ev as unknown as { sumiSynthetic: boolean }).sumiSynthetic = true;
  return ev;
}

export function isSynthetic(e: Event): boolean {
  return !!(e as unknown as { sumiSynthetic?: boolean }).sumiSynthetic;
}

export type KeyBinding = { command: string } | { prefix: true };

/** A flat keymap: sequences such as "C-x C-f" map to command names. */
export class Keymap {
  readonly bindings = new Map<string, string>();
  private readonly prefixes = new Set<string>();

  constructor(readonly name: string, init?: Record<string, string>) {
    if (init) for (const [k, v] of Object.entries(init)) this.bind(k, v);
  }

  bind(seq: string, command: string): void {
    const keys = seq.trim().split(/\s+/);
    this.bindings.set(keys.join(" "), command);
    for (let i = 1; i < keys.length; i++) this.prefixes.add(keys.slice(0, i).join(" "));
  }

  unbind(seq: string): void {
    this.bindings.delete(seq.trim().split(/\s+/).join(" "));
  }

  lookup(keys: string[]): KeyBinding | undefined {
    const seq = keys.join(" ");
    const cmd = this.bindings.get(seq);
    if (cmd) return { command: cmd };
    if (this.prefixes.has(seq)) return { prefix: true };
    return undefined;
  }

  /** All sequences bound to a command. */
  keysFor(command: string): string[] {
    const out: string[] = [];
    for (const [k, v] of this.bindings) if (v === command) out.push(k);
    return out;
  }
}
