import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { chatApiPlugin, isChatRoute, parseChatRequestBody, streamChatSse, type ChatApiDeps } from "../vite-chat-api";

type Event = { type: string; [key: string]: unknown };

type FakeRes = {
  statusCode: number;
  headers: Record<string, string>;
  chunks: string[];
  ended: boolean;
  setHeader: (key: string, value: string) => void;
  write: (chunk: string) => void;
  end: (body?: string) => void;
};

function captureMiddleware(pluginDeps?: ChatApiDeps) {
  const plugin = pluginDeps ? chatApiPlugin(pluginDeps) : chatApiPlugin();
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
  (
    plugin as unknown as { configureServer: (server: { middlewares: { use: (fn: unknown) => void } }) => void }
  ).configureServer({
    middlewares: {
      use: (fn) => {
        middleware = fn as typeof middleware;
      },
    },
  });
  return middleware as (req: unknown, res: unknown, next: () => void) => void;
}

function fakeReq(method: string, url: string, body: string) {
  const req = Readable.from([body]) as Readable & { method: string; url: string };
  req.method = method;
  req.url = url;
  return req;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
    end(body) {
      if (body !== undefined) this.chunks.push(body);
      this.ended = true;
    },
  };
}

async function waitUntilEnded(res: FakeRes) {
  for (let i = 0; i < 500 && !res.ended; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

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

describe("chatApiPlugin middleware (#6517)", () => {
  it("passes a non-chat request through to next() without responding", () => {
    const middleware = captureMiddleware(deps([{ type: "done" }]));
    const res = fakeRes();
    let nexted = false;
    middleware(fakeReq("GET", "/api/run-state", ""), res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(res.ended).toBe(false);
  });

  it("rejects a malformed body with a non-streamed 400 JSON error before opening a stream", async () => {
    const middleware = captureMiddleware(deps([{ type: "done" }]));
    const res = fakeRes();
    middleware(fakeReq("POST", "/api/chat", "{bad"), res, () => {});
    await waitUntilEnded(res);
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.chunks.join("")).toBe(JSON.stringify({ error: "invalid_json" }));
  });

  it("streams the grounding events as SSE for a valid body", async () => {
    const middleware = captureMiddleware(deps([{ type: "text", text: "hi" }, { type: "done" }]));
    const res = fakeRes();
    middleware(
      fakeReq("POST", "/api/chat", JSON.stringify({ messages: [{ role: "user", content: "status?" }] })),
      res,
      () => {},
    );
    await waitUntilEnded(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.chunks).toEqual([
      `data: ${JSON.stringify({ type: "text", text: "hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "done" })}\n\n`,
    ]);
    expect(res.ended).toBe(true);
  });

  it("falls back to the default engine module (fail-closed) when no deps are injected", async () => {
    // No deps => the real streamChatGrounding from the built engine dist; the test env configures no
    // agent-sdk provider, so it emits a single fail-closed error event then done — never a real model call.
    const middleware = captureMiddleware();
    const res = fakeRes();
    middleware(
      fakeReq("POST", "/api/chat", JSON.stringify({ messages: [{ role: "user", content: "q" }] })),
      res,
      () => {},
    );
    await waitUntilEnded(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const joined = res.chunks.join("");
    expect(joined).toContain('"type":"error"');
    expect(joined).toContain('"type":"done"');
  });
});
