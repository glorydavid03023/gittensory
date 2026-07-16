import { describe, expect, it } from "vitest";

import { isChatRoute, parseChatRequestBody, streamChatSse, type ChatApiDeps } from "../vite-chat-api";

type Event = { type: string; [key: string]: unknown };

function deps(events: Event[], overrides: Partial<ChatApiDeps> = {}): ChatApiDeps {
  return {
    loadChatGroundingModule: async () => ({
      streamChatGrounding: () =>
        (async function* () {
          yield* events;
        })(),
    }),
    env: { MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe("isChatRoute (#6517)", () => {
  it("matches only POST /api/chat", () => {
    expect(isChatRoute("POST", "/api/chat")).toBe(true);
    expect(isChatRoute("GET", "/api/chat")).toBe(false);
    expect(isChatRoute("POST", "/api/run-state")).toBe(false);
    expect(isChatRoute(undefined, "/api/chat")).toBe(false);
  });
});

describe("parseChatRequestBody (#6517)", () => {
  it("accepts a well-formed body ending in a user message", () => {
    const parsed = parseChatRequestBody(
      JSON.stringify({
        messages: [
          { role: "assistant", content: "hi" },
          { role: "user", content: "status?" },
        ],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      messages: [
        { role: "assistant", content: "hi" },
        { role: "user", content: "status?" },
      ],
    });
  });

  it("rejects empty, non-JSON, non-array/empty, malformed-message, and non-user-last bodies with a 400 JSON error", () => {
    expect(parseChatRequestBody("")).toEqual({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "empty_request_body" }),
    });
    expect(parseChatRequestBody("{not json")).toEqual({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "invalid_json" }),
    });
    expect(parseChatRequestBody(JSON.stringify({ messages: "x" }))).toEqual({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "messages_required" }),
    });
    expect(parseChatRequestBody(JSON.stringify({ messages: [] }))).toEqual({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "messages_required" }),
    });
    expect(parseChatRequestBody(JSON.stringify({ messages: [{ role: "system", content: "x" }] }))).toEqual({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "invalid_message" }),
    });
    expect(parseChatRequestBody(JSON.stringify({ messages: [{ role: "user", content: 5 }] }))).toEqual({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "invalid_message" }),
    });
    expect(
      parseChatRequestBody(
        JSON.stringify({
          messages: [
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "last_message_must_be_user" }),
    });
  });
});

describe("streamChatSse (#6517)", () => {
  it("re-emits each grounding event as one SSE data line, terminated by done", async () => {
    const chunks = await collect(
      streamChatSse(
        [{ role: "user", content: "status?" }],
        deps([
          { type: "tool_call", tool: "loopover_miner_status", input: {} },
          { type: "text", text: "1 running loop." },
          { type: "done" },
        ]),
      ),
    );
    expect(chunks).toEqual([
      `data: ${JSON.stringify({ type: "tool_call", tool: "loopover_miner_status", input: {} })}\n\n`,
      `data: ${JSON.stringify({ type: "text", text: "1 running loop." })}\n\n`,
      `data: ${JSON.stringify({ type: "done" })}\n\n`,
    ]);
  });

  it("passes the injected env through to the grounding module", async () => {
    let seenEnv: Record<string, string | undefined> | undefined;
    const custom: ChatApiDeps = {
      loadChatGroundingModule: async () => ({
        streamChatGrounding: (params) => {
          seenEnv = params.env;
          return (async function* () {
            yield { type: "done" };
          })();
        },
      }),
      env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
    };
    await collect(streamChatSse([{ role: "user", content: "q" }], custom));
    expect(seenEnv).toEqual({ MINER_CODING_AGENT_PROVIDER: "claude-cli" });
  });
});
