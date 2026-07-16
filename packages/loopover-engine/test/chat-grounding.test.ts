import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../dist/index.js";

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

async function collect(
  gen: AsyncGenerator<ChatGroundingEvent>,
): Promise<ChatGroundingEvent[]> {
  const events: ChatGroundingEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const AGENT_SDK_ENV = { MINER_CODING_AGENT_PROVIDER: "agent-sdk" };
const USER_MSG: ChatMessage[] = [{ role: "user", content: "status?" }];
const assistant = (
  ...blocks: Array<Record<string, unknown>>
): Record<string, unknown> => ({
  type: "assistant",
  message: { content: blocks },
});
const user = (
  ...blocks: Array<Record<string, unknown>>
): Record<string, unknown> => ({ type: "user", message: { content: blocks } });

test("fails closed when no provider is configured", async () => {
  const events = await collect(
    streamChatGrounding({ messages: USER_MSG, env: {} }),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["error", "done"],
  );
  assert.equal(
    (events[0] as { code: string }).code,
    "no_coding_agent_configured",
  );
});

test("fails closed for a non-agent-sdk provider", async () => {
  const events = await collect(
    streamChatGrounding({
      messages: USER_MSG,
      env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
    }),
  );
  assert.equal(
    (events[0] as { code: string }).code,
    "chat_requires_agent_sdk_provider",
  );
});

test("passes exactly the 11 tools, system prompt, and stdio MCP server to the session", async () => {
  const captured: { input?: Parameters<ChatGroundingQueryFn>[0] } = {};
  await collect(
    streamChatGrounding({
      messages: USER_MSG,
      env: AGENT_SDK_ENV,
      query: queryYielding([{ type: "result" }], captured),
    }),
  );
  const options = captured.input!.options as Record<string, unknown>;
  assert.deepEqual(options.allowedTools, [...CHAT_GROUNDING_TOOL_ALLOWLIST]);
  assert.equal((options.allowedTools as string[]).length, 11);
  assert.equal(options.systemPrompt, CHAT_GROUNDING_SYSTEM_PROMPT);
  assert.deepEqual(options.mcpServers, {
    [MINER_MCP_SERVER_NAME]: {
      command: "node",
      args: ["packages/loopover-miner/bin/loopover-miner-mcp.js"],
    },
  });
});

test("streams text, correlates tool_call/tool_result, redacts blocked terms, stops at result", async () => {
  const events = await collect(
    streamChatGrounding({
      messages: USER_MSG,
      env: AGENT_SDK_ENV,
      query: queryYielding([
        assistant({
          type: "tool_use",
          id: "c1",
          name: "loopover_miner_status",
          input: { verbose: true },
        }),
        user({ type: "tool_result", tool_use_id: "c1", content: { ok: true } }),
        assistant({ type: "text", text: "Your trust score is high." }),
        assistant({ type: "text", text: "You have 1 running loop." }),
        { type: "result", subtype: "success" },
        assistant({ type: "text", text: "unreached" }),
      ]),
    }),
  );
  assert.deepEqual(events, [
    {
      type: "tool_call",
      tool: "loopover_miner_status",
      input: { verbose: true },
    },
    {
      type: "tool_result",
      tool: "loopover_miner_status",
      output: { ok: true },
    },
    { type: "text", text: redactBlockedText("Your trust score is high.") },
    { type: "text", text: "You have 1 running loop." },
    { type: "done" },
  ]);
});

test("emits chat_stream_failed then done when the stream throws", async () => {
  const query: ChatGroundingQueryFn = () =>
    (async function* () {
      await Promise.reject(new Error("boom"));
    })();
  const events = await collect(
    streamChatGrounding({ messages: USER_MSG, env: AGENT_SDK_ENV, query }),
  );
  assert.deepEqual(events, [
    { type: "error", code: "chat_stream_failed", message: "boom" },
    { type: "done" },
  ]);
});

test("buildGroundingPrompt and redactBlockedText behave", () => {
  assert.equal(
    buildGroundingPrompt([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]),
    "User: hi\n\nAssistant: yo",
  );
  assert.match(redactBlockedText("wallet address"), /redacted/);
  assert.equal(redactBlockedText("2 merged PRs"), "2 merged PRs");
});
