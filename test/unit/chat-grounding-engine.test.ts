// Vitest mirror of packages/loopover-engine/test/chat-grounding.test.ts (#6517). The engine's own node:test
// suite is not visible to Codecov, so this vitest copy is what the 99% patch bar measures for
// packages/loopover-engine/src/miner/chat-grounding.ts — it exercises both sides of every branch.
import { describe, expect, it } from "vitest";
import {
  CHAT_GROUNDING_SYSTEM_PROMPT,
  CHAT_GROUNDING_TOOL_ALLOWLIST,
  MINER_MCP_SERVER_NAME,
  buildGroundingPrompt,
  redactBlockedText,
  streamChatGrounding,
  type ChatGroundingEvent,
  type ChatGroundingQueryFn,
  type ChatMessage,
} from "../../packages/loopover-engine/src/miner/chat-grounding";

/** A fake ChatGroundingQueryFn that yields the given SDK-shaped messages and captures the input it received. */
function queryYielding(
  messages: Array<Record<string, unknown>>,
  captured?: { input?: Parameters<ChatGroundingQueryFn>[0] },
): ChatGroundingQueryFn {
  return (input) => {
    if (captured) captured.input = input;
    return (async function* () {
      yield* messages;
    })();
  };
}

function queryThrowing(error: unknown): ChatGroundingQueryFn {
  return () =>
    (async function* () {
      await Promise.reject(error);
    })();
}

async function collect(
  gen: AsyncGenerator<ChatGroundingEvent>,
): Promise<ChatGroundingEvent[]> {
  const events: ChatGroundingEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const AGENT_SDK_ENV = { MINER_CODING_AGENT_PROVIDER: "agent-sdk" };
const USER_MSG: ChatMessage[] = [
  { role: "user", content: "what's my portfolio status?" },
];

function assistant(
  ...blocks: Array<Record<string, unknown>>
): Record<string, unknown> {
  return { type: "assistant", message: { content: blocks } };
}
function user(
  ...blocks: Array<Record<string, unknown>>
): Record<string, unknown> {
  return { type: "user", message: { content: blocks } };
}

describe("streamChatGrounding provider gating (#6517)", () => {
  it("fails closed with no_coding_agent_configured when no provider is configured, then done", async () => {
    const events = await collect(
      streamChatGrounding({ messages: USER_MSG, env: {} }),
    );
    expect(events).toEqual([
      {
        type: "error",
        code: "no_coding_agent_configured",
        message: expect.stringContaining("agent-sdk"),
      },
      { type: "done" },
    ]);
  });

  it("fails closed with chat_requires_agent_sdk_provider for a wrong (claude-cli) provider, then done", async () => {
    const events = await collect(
      streamChatGrounding({
        messages: USER_MSG,
        env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
      }),
    );
    expect(events).toEqual([
      {
        type: "error",
        code: "chat_requires_agent_sdk_provider",
        message: expect.stringContaining("claude-cli"),
      },
      { type: "done" },
    ]);
  });

  it("never calls the query fn on a fail-closed provider path", async () => {
    let called = false;
    const query: ChatGroundingQueryFn = () => {
      called = true;
      return (async function* () {})();
    };
    await collect(
      streamChatGrounding({
        messages: USER_MSG,
        env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
        query,
      }),
    );
    expect(called).toBe(false);
  });
});

describe("streamChatGrounding session wiring (#6517)", () => {
  it("passes exactly the 11 read-only tool names, the system prompt, and the stdio MCP server to the session", async () => {
    const captured: { input?: Parameters<ChatGroundingQueryFn>[0] } = {};
    await collect(
      streamChatGrounding({
        messages: USER_MSG,
        env: AGENT_SDK_ENV,
        query: queryYielding([{ type: "result" }], captured),
      }),
    );
    const options = captured.input!.options as Record<string, unknown>;
    expect(options.allowedTools).toEqual([...CHAT_GROUNDING_TOOL_ALLOWLIST]);
    expect((options.allowedTools as string[]).length).toBe(11);
    expect(options.systemPrompt).toBe(CHAT_GROUNDING_SYSTEM_PROMPT);
    expect(options.mcpServers).toEqual({
      [MINER_MCP_SERVER_NAME]: {
        command: "node",
        args: ["packages/loopover-miner/bin/loopover-miner-mcp.js"],
      },
    });
    expect(captured.input!.prompt).toContain("what's my portfolio status?");
  });

  it("streams assistant text as text events and stops at the terminal result message", async () => {
    const query = queryYielding([
      assistant({ type: "text", text: "Your portfolio has 3 active loops." }),
      { type: "result", subtype: "success" },
      assistant({ type: "text", text: "this must never be reached" }),
    ]);
    const events = await collect(
      streamChatGrounding({ messages: USER_MSG, env: AGENT_SDK_ENV, query }),
    );
    expect(events).toEqual([
      { type: "text", text: "Your portfolio has 3 active loops." },
      { type: "done" },
    ]);
  });

  it("surfaces a tool_use as tool_call and the matching tool_result with the correlated tool name", async () => {
    const query = queryYielding([
      assistant({
        type: "tool_use",
        id: "call_1",
        name: "loopover_miner_get_portfolio_dashboard",
        input: { limit: 5 },
      }),
      user({
        type: "tool_result",
        tool_use_id: "call_1",
        content: { rows: [] },
      }),
      assistant({ type: "text", text: "You have no open items." }),
      { type: "result", subtype: "success" },
    ]);
    const events = await collect(
      streamChatGrounding({ messages: USER_MSG, env: AGENT_SDK_ENV, query }),
    );
    expect(events).toEqual([
      {
        type: "tool_call",
        tool: "loopover_miner_get_portfolio_dashboard",
        input: { limit: 5 },
      },
      {
        type: "tool_result",
        tool: "loopover_miner_get_portfolio_dashboard",
        output: { rows: [] },
      },
      { type: "text", text: "You have no open items." },
      { type: "done" },
    ]);
  });

  it("defaults a tool_use with no id/input and an uncorrelated tool_result with absent content", async () => {
    const query = queryYielding([
      assistant({ type: "tool_use", name: "loopover_miner_ping" }),
      user({ type: "tool_result", content: undefined }),
      { type: "result", subtype: "success" },
    ]);
    const events = await collect(
      streamChatGrounding({ messages: USER_MSG, env: AGENT_SDK_ENV, query }),
    );
    expect(events).toEqual([
      { type: "tool_call", tool: "loopover_miner_ping", input: {} },
      { type: "tool_result", tool: "unknown", output: null },
      { type: "done" },
    ]);
  });

  it("redacts a text chunk that names a blocked term, forwards a clean one verbatim", async () => {
    const query = queryYielding([
      assistant({ type: "text", text: "Your trust score is high." }),
      assistant({ type: "text", text: "You have 2 merged PRs." }),
      { type: "result", subtype: "success" },
    ]);
    const events = await collect(
      streamChatGrounding({ messages: USER_MSG, env: AGENT_SDK_ENV, query }),
    );
    expect(events[0]).toEqual({
      type: "text",
      text: expect.stringContaining("[redacted"),
    });
    expect(events[1]).toEqual({ type: "text", text: "You have 2 merged PRs." });
    expect(events[2]).toEqual({ type: "done" });
  });

  it("ignores non-array content, null blocks, unknown block types, and non-assistant/user messages", async () => {
    const query = queryYielding([
      { type: "assistant", message: { content: "not-an-array" } },
      assistant(
        null as unknown as Record<string, unknown>,
        { type: "image", data: "x" },
        { type: "text", text: "kept" },
      ),
      {
        type: "system",
        message: { content: [{ type: "text", text: "ignored system text" }] },
      },
      { type: "result", subtype: "success" },
    ]);
    const events = await collect(
      streamChatGrounding({ messages: USER_MSG, env: AGENT_SDK_ENV, query }),
    );
    expect(events).toEqual([{ type: "text", text: "kept" }, { type: "done" }]);
  });

  it("emits chat_stream_failed then done when the query stream throws (Error and non-Error)", async () => {
    const fromError = await collect(
      streamChatGrounding({
        messages: USER_MSG,
        env: AGENT_SDK_ENV,
        query: queryThrowing(new Error("boom")),
      }),
    );
    expect(fromError).toEqual([
      { type: "error", code: "chat_stream_failed", message: "boom" },
      { type: "done" },
    ]);
    const fromString = await collect(
      streamChatGrounding({
        messages: USER_MSG,
        env: AGENT_SDK_ENV,
        query: queryThrowing("stringy"),
      }),
    );
    expect(fromString).toEqual([
      { type: "error", code: "chat_stream_failed", message: "stringy" },
      { type: "done" },
    ]);
  });
});

describe("chat-grounding pure helpers (#6517)", () => {
  it("buildGroundingPrompt labels user and assistant turns", () => {
    expect(
      buildGroundingPrompt([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "status?" },
      ]),
    ).toBe("User: hi\n\nAssistant: hello\n\nUser: status?");
  });

  it("redactBlockedText replaces blocked terms and passes clean text through", () => {
    expect(redactBlockedText("your wallet address")).toContain("[redacted");
    expect(redactBlockedText("HOTKEY leak")).toContain("[redacted");
    expect(redactBlockedText("3 open PRs and 2 merges")).toBe(
      "3 open PRs and 2 merges",
    );
  });

  it("the tool allowlist is frozen and holds exactly the 11 read-only tools", () => {
    expect(Object.isFrozen(CHAT_GROUNDING_TOOL_ALLOWLIST)).toBe(true);
    expect(CHAT_GROUNDING_TOOL_ALLOWLIST).toHaveLength(11);
    expect(
      CHAT_GROUNDING_TOOL_ALLOWLIST.every((name) =>
        name.startsWith("loopover_miner_"),
      ),
    ).toBe(true);
  });
});
