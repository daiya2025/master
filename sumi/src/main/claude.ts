import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { WebContents } from "electron";
import type { ClaudeEvent, ClaudeRequest } from "../shared/ipc";
import { getSettings, resolveApiKey } from "./settings";

/** Models that accept the server-side refusal fallback chain. */
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
]);

interface ActiveStream {
  abort(): void;
}

const active = new Map<string, ActiveStream>();

function send(wc: WebContents, ev: ClaudeEvent): void {
  if (!wc.isDestroyed()) wc.send("claude:event", ev);
}

export function abortStream(id: string): void {
  active.get(id)?.abort();
}

export function abortAll(): void {
  for (const s of active.values()) s.abort();
}

/**
 * Starts a streaming Messages request and forwards events to the renderer.
 * The renderer owns the conversation and the tool loop; this only talks to the API.
 */
export async function startStream(wc: WebContents, req: ClaudeRequest): Promise<void> {
  const id = String(req.id);
  if (active.has(id)) {
    send(wc, { id, type: "error", code: "api", error: "duplicate request id" });
    return;
  }
  if (process.env.SUMI_FAKE_CLAUDE) {
    void runFake(wc, id, req);
    return;
  }

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    queueMicrotask(() =>
      send(wc, {
        id,
        type: "error",
        code: "no_api_key",
        error: "API キーが未設定です。M-x claude-set-api-key で設定してください (または環境変数 ANTHROPIC_API_KEY)。",
      }),
    );
    return;
  }

  const settings = await getSettings();
  const model = req.model ?? settings.model;
  const effort = req.effort ?? settings.effort;
  const maxTokens = req.maxTokens ?? settings.maxTokens;
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  const useFallback = FALLBACK_MODELS.has(model);
  const params: BetaMessageStreamParams = {
    model,
    max_tokens: maxTokens,
    messages: req.messages,
    thinking: { type: "adaptive", display: settings.showThinking ? "summarized" : "omitted" },
    output_config: { effort },
    ...(req.system ? { system: req.system } : {}),
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };

  const stream = client.beta.messages.stream(params);
  active.set(id, { abort: () => stream.abort() });

  void (async () => {
    try {
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          send(wc, { id, type: "tool_use_start", name: event.content_block.name });
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            send(wc, { id, type: "text", text: event.delta.text });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            send(wc, { id, type: "thinking", text: event.delta.thinking });
          }
        }
      }
      const message = await stream.finalMessage();
      send(wc, { id, type: "done", message });
    } catch (err) {
      if (stream.aborted || (err instanceof Error && err.name === "AbortError")) {
        send(wc, { id, type: "aborted" });
      } else if (err instanceof Anthropic.AuthenticationError) {
        send(wc, { id, type: "error", code: "auth", status: err.status, error: "API キーが無効です: " + err.message });
      } else if (err instanceof Anthropic.RateLimitError) {
        send(wc, { id, type: "error", code: "rate_limit", status: err.status, error: "レート制限中です。少し待って再試行してください。" });
      } else if (err instanceof Anthropic.APIError) {
        send(wc, { id, type: "error", code: "api", status: err.status, error: `API error ${err.status ?? ""}: ${err.message}` });
      } else if (err instanceof Anthropic.APIConnectionError) {
        send(wc, { id, type: "error", code: "network", error: "接続エラー: " + err.message });
      } else {
        send(wc, { id, type: "error", code: "api", error: String(err) });
      }
    } finally {
      active.delete(id);
    }
  })();
}

/** Deterministic stand-in used by the smoke test (SUMI_FAKE_CLAUDE=1). */
async function runFake(wc: WebContents, id: string, req: ClaudeRequest): Promise<void> {
  let cancelled = false;
  active.set(id, { abort: () => (cancelled = true) });
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const last = req.messages[req.messages.length - 1];
    const hasToolResult =
      Array.isArray(last?.content) && last.content.some((b) => (b as { type: string }).type === "tool_result");
    const wantsTools = !!req.tools?.length && !hasToolResult;
    const usage = { input_tokens: 10, output_tokens: 5 } as unknown as Anthropic.Beta.BetaUsage;
    if (wantsTools) {
      send(wc, { id, type: "tool_use_start", name: "list_buffers" });
      await delay(10);
      send(wc, {
        id,
        type: "done",
        message: {
          id: "msg_fake1",
          type: "message",
          role: "assistant",
          model: "fake",
          stop_reason: "tool_use",
          stop_sequence: null,
          usage,
          content: [{ type: "tool_use", id: "toolu_fake1", name: "list_buffers", input: {} }],
        } as unknown as Anthropic.Beta.BetaMessage,
      });
      return;
    }
    const words = ["こんにちは！", " Sumi", " から", " Claude", " です。"];
    for (const w of words) {
      if (cancelled) {
        send(wc, { id, type: "aborted" });
        return;
      }
      send(wc, { id, type: "text", text: w });
      await delay(5);
    }
    send(wc, {
      id,
      type: "done",
      message: {
        id: "msg_fake2",
        type: "message",
        role: "assistant",
        model: "fake",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
        content: [{ type: "text", text: words.join("") }],
      } as unknown as Anthropic.Beta.BetaMessage,
    });
  } finally {
    active.delete(id);
  }
}
