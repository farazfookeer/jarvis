// Thin streaming proxy to Claude. The browser owns the agentic loop (it holds
// the tools and executes them); this module runs exactly one model turn and
// hands back the full assistant content so the browser can continue.
//
// Model: Claude Opus 5.5. A few of its traits shape this file:
//  - Thinking is always on (adaptive); there's no "off". We steer cost/latency
//    with `effort` instead ("low" for quick chat, "medium" for the brainstorm map).
//  - Thinking blocks are tied to the model + conversation, so we return the
//    WHOLE content array (thinking + tool_use + text) unchanged. The browser
//    echoes it back on the follow-up turn or the next request 400s.
//  - `display: "summarized"` lets interim reasoning stream rather than going
//    silent between tool calls.
import Anthropic from "@anthropic-ai/sdk";
import { getSecret, KEYS } from "./secrets.js";

// One constant to change if we ever move to Fable 5.1 for maximum capability.
export const MODEL = "claude-opus-5-5";

let client = null;
async function getClient() {
  if (client) return client;
  const apiKey = await getSecret(KEYS.CLAUDE_API_KEY);
  if (!apiKey) {
    const e = new Error("Claude API key is not set");
    e.code = "not_granted";
    throw e;
  }
  client = new Anthropic({ apiKey });
  return client;
}

// Run one turn. onText receives answer text deltas as they stream. Returns the
// complete assistant message so the caller can detect tool_use and loop.
export async function runTurn(
  { messages, tools, system, effort = "low", maxTokens = 8000 },
  { onText, signal } = {},
) {
  const c = await getClient();
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    messages,
  };
  if (system) params.system = system;
  if (tools?.length) {
    params.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema || t.input_schema,
    }));
  }

  const stream = c.messages.stream(params, signal ? { signal } : undefined);
  if (onText) stream.on("text", (delta) => onText(delta));
  const final = await stream.finalMessage();
  return {
    content: final.content,
    stop_reason: final.stop_reason,
    usage: final.usage,
    model: final.model,
  };
}

// Map SDK/API errors to the short codes the prototype's error copy understands
// (see sampleCopy in app.js).
export function mapError(e) {
  if (e?.code) return e.code;
  if (e?.name === "AbortError") return "cancelled";
  const status = e?.status;
  if (status === 401) return "session_expired";
  if (status === 403) return "not_granted";
  if (status === 429) return "rate_limited";
  if (status === 413) return "prompt_too_large";
  if (status >= 500) return "upstream_error";
  return "upstream_error";
}
