import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../shared/ipc";

interface StoredConfig extends Omit<Settings, "apiKeySource"> {
  /** base64 of the safeStorage-encrypted key (or plaintext with the "plain:" prefix when encryption is unavailable). */
  apiKey?: string;
}

let cache: StoredConfig | null = null;

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

async function load(): Promise<StoredConfig> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    const { apiKeySource: _ignored, ...defaults } = DEFAULT_SETTINGS;
    cache = { ...defaults, ...parsed };
  } catch {
    const { apiKeySource: _ignored, ...defaults } = DEFAULT_SETTINGS;
    cache = { ...defaults };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(cache, null, 2), "utf8");
}

export async function getSettings(): Promise<Settings> {
  const cfg = await load();
  const { apiKey, ...rest } = cfg;
  const apiKeySource: Settings["apiKeySource"] = process.env.ANTHROPIC_API_KEY
    ? "env"
    : apiKey
      ? "stored"
      : "none";
  return { ...rest, apiKeySource };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const cfg = await load();
  const { apiKeySource: _ignored, ...safePatch } = patch;
  Object.assign(cfg, safePatch);
  await persist();
  return getSettings();
}

export async function setApiKey(key: string): Promise<void> {
  const cfg = await load();
  const trimmed = key.trim();
  if (!trimmed) {
    delete cfg.apiKey;
  } else if (safeStorage.isEncryptionAvailable()) {
    const enc = await safeStorage.encryptStringAsync(trimmed);
    cfg.apiKey = enc.toString("base64");
  } else {
    // Linux without a keyring, or similar. Windows 11 always has DPAPI available.
    cfg.apiKey = "plain:" + Buffer.from(trimmed, "utf8").toString("base64");
  }
  await persist();
}

export async function clearApiKey(): Promise<void> {
  const cfg = await load();
  delete cfg.apiKey;
  await persist();
}

/** Resolves the API key: environment first, then the encrypted store. */
export async function resolveApiKey(): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const cfg = await load();
  if (!cfg.apiKey) return null;
  if (cfg.apiKey.startsWith("plain:")) {
    return Buffer.from(cfg.apiKey.slice(6), "base64").toString("utf8");
  }
  try {
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(cfg.apiKey, "base64"));
    return result;
  } catch {
    return null;
  }
}
