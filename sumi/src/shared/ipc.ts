// Types shared between the Electron main process, the preload bridge and the renderer.
import type Anthropic from "@anthropic-ai/sdk";

export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaTool = Anthropic.Beta.BetaTool;
export type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export type ReadFileResult =
  | { ok: true; text: string; path: string }
  | { ok: false; error: string; notFound: boolean; isDirectory: boolean; path: string };

export type WriteFileResult = { ok: true; path: string } | { ok: false; error: string };

export type ReadDirResult =
  | { ok: true; path: string; entries: FileEntry[] }
  | { ok: false; error: string };

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  model: string;
  effort: Effort;
  maxTokens: number;
  theme: "dark" | "light";
  fontSize: number;
  showThinking: boolean;
  toolsEnabled: boolean;
  /** Where the API key comes from. Never carries the key itself. */
  apiKeySource: "none" | "env" | "stored";
}

export const DEFAULT_SETTINGS: Settings = {
  model: "claude-opus-5-5",
  effort: "high",
  maxTokens: 32000,
  theme: "dark",
  fontSize: 15,
  showThinking: false,
  toolsEnabled: true,
  apiKeySource: "none",
};

export const MODEL_CHOICES: { id: string; label: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (fast)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 (most capable)" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
];

export interface ClaudeRequest {
  /** Chosen by the renderer so it can register its listener before the first event arrives. */
  id: string;
  system?: string;
  messages: BetaMessageParam[];
  tools?: BetaTool[];
  /** Overrides for this request only. */
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

export type ClaudeEvent =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "thinking"; text: string }
  | { id: string; type: "tool_use_start"; name: string }
  | { id: string; type: "done"; message: BetaMessage }
  | { id: string; type: "error"; error: string; status?: number; code?: "no_api_key" | "auth" | "rate_limit" | "api" | "network" }
  | { id: string; type: "aborted" };

export interface SumiApi {
  fs: {
    readFile(path: string): Promise<ReadFileResult>;
    writeFile(path: string, text: string): Promise<WriteFileResult>;
    readDir(path: string): Promise<ReadDirResult>;
    stat(path: string): Promise<FileEntry | null>;
    resolve(path: string, base?: string): Promise<string>;
    dirname(path: string): Promise<string>;
    homeDir(): Promise<string>;
    cwd(): Promise<string>;
    sep(): Promise<string>;
    openDialog(defaultPath?: string): Promise<string | null>;
    saveDialog(defaultPath?: string): Promise<string | null>;
  };
  shell: {
    run(command: string, cwd: string | null, input?: string): Promise<ShellResult>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    setApiKey(key: string): Promise<{ ok: boolean; error?: string }>;
    clearApiKey(): Promise<void>;
  };
  claude: {
    stream(request: ClaudeRequest): Promise<void>;
    abort(id: string): Promise<void>;
    onEvent(cb: (ev: ClaudeEvent) => void): () => void;
  };
  app: {
    quit(): void;
    setTitle(title: string): void;
    openExternal(url: string): void;
    version(): Promise<string>;
    args(): Promise<string[]>;
    platform(): Promise<string>;
    isSmoke(): Promise<boolean>;
  };
}

declare global {
  interface Window {
    sumi: SumiApi;
  }
}
