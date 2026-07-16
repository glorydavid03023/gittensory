// Read-only conversational grounding backend (#6517). A miner-local streaming chat that answers
// natural-language questions about the miner's OWN local state by tool-calling only the 11 read-only
// `loopover_miner_*` MCP tools registered in `packages/loopover-miner/bin/loopover-miner-mcp.js` — no write
// tool, no action-dispatch, no new tool surface. It drives `@anthropic-ai/claude-agent-sdk`'s `query()` in
// process exactly the way `agent-sdk-driver.ts` does, behind the SAME injected-query test seam so no test
// ever makes a real model call. The vite `/api/chat` middleware (apps/loopover-miner-ui) re-emits each event
// this generator yields as one `data: <json>\n\n` SSE line.

import { resolveFirstConfiguredCodingAgentDriverName } from "./driver-factory.js";

export type ChatRole = "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

/** One streamed event. `text` is a partial/full answer chunk; `done` always terminates the stream. */
export type ChatGroundingEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

/** The exact v1 grounding tool surface (#6517): the 11 read-only `loopover_miner_*` tools, no more, no fewer.
 *  A future accidental 12th (or write-capable) tool must fail the invariant test, not just code review. */
export const CHAT_GROUNDING_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "loopover_miner_ping",
  "loopover_miner_get_portfolio_dashboard",
  "loopover_miner_get_manage_status",
  "loopover_miner_list_claims",
  "loopover_miner_get_audit_feed",
  "loopover_miner_get_run_state",
  "loopover_miner_list_plans",
  "loopover_miner_get_plan",
  "loopover_miner_get_governor_decisions",
  "loopover_miner_status",
  "loopover_miner_get_calibration_report",
]);

/** The MCP server the session tool-calls against — the existing read-only miner MCP bin, over stdio. */
export const MINER_MCP_SERVER_NAME = "loopover-miner";
export const MINER_MCP_BIN_RELATIVE_PATH =
  "packages/loopover-miner/bin/loopover-miner-mcp.js";

/** Session turn ceiling — a grounding answer is a short question→tool→answer loop, not an editing attempt. */
export const CHAT_GROUNDING_MAX_TURNS = 8;

/** The same term set `track-record-summary.ts`'s `PUBLIC_FIELD_BLOCKLIST` keeps out of any public surface. A
 *  conversational endpoint adds a NEW leak surface those read-only tools don't have — a user can simply ASK
 *  "what's my trust score" — so both the system prompt (instruction) and the output backstop (enforcement)
 *  refuse the same terms. Kept as a local copy, not an import, because that module's list is private to it. */
const REDACTION_PATTERNS: readonly RegExp[] = [
  /\btrust\s*score\b/iu,
  /\btrustscore\b/iu,
  /\bscoreability\b/iu,
  /\breward\b/iu,
  /\bpayout\b/iu,
  /\branking\b/iu,
  /\bprivate\s*scor/iu,
  /\bwallet\b/iu,
  /\bhotkey\b/iu,
  /\bcoldkey\b/iu,
];

const REDACTION_PLACEHOLDER =
  "[redacted: this assistant cannot share wallet, hotkey, coldkey, reward, payout, or trust-score data — no available tool exposes it]";

/** Output-side defense-in-depth (#6517): the system prompt alone is not enforcement. Any answer chunk that
 *  names a blocked term is replaced wholesale rather than forwarded verbatim, even though no known tool path
 *  produces one today. */
export function redactBlockedText(text: string): string {
  return REDACTION_PATTERNS.some((pattern) => pattern.test(text))
    ? REDACTION_PLACEHOLDER
    : text;
}

export const CHAT_GROUNDING_SYSTEM_PROMPT = [
  "You are the loopover-miner assistant. You answer questions about THIS miner's own local state by calling",
  "the available read-only tools and grounding every answer in their output. You never invent numbers.",
  "If no tool provides the answer, say so plainly instead of guessing.",
  "You must decline any request for wallet, hotkey, coldkey, reward, payout, ranking, or trust-score data:",
  "none of your available tools expose it, so state that plainly and do not speculate.",
].join(" ");

/** Injected `query()`-shaped function (mirrors `agent-sdk-driver.ts`'s `AgentSdkQueryFn` seam) so tests drive
 *  a fake async-iterable and CI never makes a real model call. */
export type ChatGroundingQueryFn = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

/* v8 ignore start -- real-SDK path: imports @anthropic-ai/claude-agent-sdk and spawns a live session wired to
   the stdio MCP server; every test injects a fake ChatGroundingQueryFn instead (same convention the CLI/SDK
   coding-agent drivers use). */
const defaultQuery: ChatGroundingQueryFn = (input) => {
  async function* stream(): AsyncGenerator<Record<string, unknown>> {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
      query: (params: {
        prompt: string;
        options?: Record<string, unknown>;
      }) => AsyncIterable<unknown>;
    };
    for await (const message of sdk.query({
      prompt: input.prompt,
      options: input.options,
    })) {
      yield message as Record<string, unknown>;
    }
  }
  return stream();
};
/* v8 ignore stop */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Flatten the conversation history into a single prompt turn. The caller has already validated the last
 *  message is the user's current question; prior turns are prepended verbatim as context. */
export function buildGroundingPrompt(messages: readonly ChatMessage[]): string {
  return messages
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`,
    )
    .join("\n\n");
}

/** Map one SDK stream message to zero-or-more grounding events. Assistant `text`/`tool_use` blocks and the
 *  matching `user` `tool_result` blocks are surfaced; every other block type is ignored. The terminal
 *  `result` message is handled by the caller, not here. */
function* mapSdkMessage(
  message: Record<string, unknown>,
  toolNamesById: Map<string, string>,
): Generator<ChatGroundingEvent> {
  const content = asRecord(message.message)?.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      yield { type: "text", text: redactBlockedText(block.text) };
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      if (typeof block.id === "string") toolNamesById.set(block.id, block.name);
      yield {
        type: "tool_call",
        tool: block.name,
        input: asRecord(block.input) ?? {},
      };
    } else if (block.type === "tool_result") {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      yield {
        type: "tool_result",
        tool: toolNamesById.get(toolUseId) ?? "unknown",
        output: block.content ?? null,
      };
    }
  }
}

/**
 * Stream a grounded answer to the miner's own state. Yields `ChatGroundingEvent`s and ALWAYS ends with a
 * single `done`, including on the fail-closed provider paths and on a thrown stream. Requires the `agent-sdk`
 * provider specifically — the `claude-cli`/`codex-cli` drivers are one-shot buffered coding drivers, not a fit
 * for a conversational streaming tool-calling loop, so an unconfigured or wrong provider yields one `error`
 * event and stops, never a partial/mock/echoed answer.
 */
export async function* streamChatGrounding(params: {
  messages: readonly ChatMessage[];
  env: Record<string, string | undefined>;
  query?: ChatGroundingQueryFn;
}): AsyncGenerator<ChatGroundingEvent> {
  const provider = resolveFirstConfiguredCodingAgentDriverName(params.env);
  if (provider === undefined) {
    yield {
      type: "error",
      code: "no_coding_agent_configured",
      message:
        "No coding-agent provider is configured; chat requires the agent-sdk provider.",
    };
    yield { type: "done" };
    return;
  }
  if (provider !== "agent-sdk") {
    yield {
      type: "error",
      code: "chat_requires_agent_sdk_provider",
      message: `Chat requires the agent-sdk provider, but "${provider}" is configured.`,
    };
    yield { type: "done" };
    return;
  }

  /* v8 ignore next -- every test injects params.query; the defaultQuery fallback is the v8-ignored real-SDK path. */
  const query = params.query ?? defaultQuery;
  const toolNamesById = new Map<string, string>();
  try {
    const stream = query({
      prompt: buildGroundingPrompt(params.messages),
      options: {
        systemPrompt: CHAT_GROUNDING_SYSTEM_PROMPT,
        maxTurns: CHAT_GROUNDING_MAX_TURNS,
        allowedTools: [...CHAT_GROUNDING_TOOL_ALLOWLIST],
        mcpServers: {
          [MINER_MCP_SERVER_NAME]: {
            command: "node",
            args: [MINER_MCP_BIN_RELATIVE_PATH],
          },
        },
      },
    });
    for await (const message of stream) {
      if (message.type === "result") break;
      if (message.type === "assistant" || message.type === "user") {
        yield* mapSdkMessage(message, toolNamesById);
      }
    }
  } catch (error) {
    yield {
      type: "error",
      code: "chat_stream_failed",
      message: (error instanceof Error ? error.message : String(error)).slice(
        0,
        500,
      ),
    };
  }
  yield { type: "done" };
}
