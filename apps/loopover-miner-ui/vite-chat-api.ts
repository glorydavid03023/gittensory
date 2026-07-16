import type { Plugin } from "vite";

// Local streaming chat endpoint for the miner-ui (#6517). The dashboard's chat rail asks natural-language
// questions about the miner's own local state; this dev-server bridge answers them by delegating to the engine's
// read-only `streamChatGrounding` (packages/loopover-engine — imported from its BUILT dist, like the sibling
// `/api/*` plugins import the miner lib), which tool-calls only the 11 read-only `loopover_miner_*` MCP tools.
//
// POST /api/chat, body `{ messages: [{ role, content }, ...] }`, responds `text/event-stream`: one
// `data: <json>\n\n` line per grounding event, always terminated by a `done` event. Auth is already handled by
// `vite-auth.ts` (registered before this plugin), so no per-endpoint auth wiring lives here. A malformed body is
// rejected with a NON-streamed 4xx JSON error before any stream is opened.

type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatGroundingEvent = { type: string; [key: string]: unknown };

type ChatGroundingModule = {
  streamChatGrounding: (params: {
    messages: ChatMessage[];
    env: Record<string, string | undefined>;
  }) => AsyncIterable<ChatGroundingEvent>;
};

export type ChatApiDeps = {
  /** Import of `packages/loopover-engine`'s built barrel — injectable so tests never make a real model call. */
  loadChatGroundingModule: () => Promise<ChatGroundingModule>;
  /** Process env used to resolve the configured coding-agent provider inside `streamChatGrounding`. */
  env: Record<string, string | undefined>;
};

const defaultDeps: ChatApiDeps = {
  loadChatGroundingModule: () => import("../../packages/loopover-engine/dist/index.js") as Promise<ChatGroundingModule>,
  env: process.env,
};

/** Pure route matcher — safe to call synchronously before reading the request body. */
export function isChatRoute(method: string | undefined, url: string | undefined): boolean {
  return url === "/api/chat" && method === "POST";
}

/** Validate the POST body. Returns the parsed messages, or a non-streamed 4xx error to send verbatim. The last
 *  message must be the user's current question; an empty/malformed array is rejected before any stream opens. */
export function parseChatRequestBody(
  rawBody: string,
): { ok: true; messages: ChatMessage[] } | { ok: false; status: number; body: string } {
  const reject = (error: string) => ({ ok: false as const, status: 400, body: JSON.stringify({ error }) });
  if (!rawBody.trim()) return reject("empty_request_body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return reject("invalid_json");
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return reject("messages_required");
  const validated: ChatMessage[] = [];
  for (const raw of messages) {
    const message = raw as { role?: unknown; content?: unknown };
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      return reject("invalid_message");
    }
    validated.push({ role: message.role, content: message.content });
  }
  if (validated[validated.length - 1].role !== "user") return reject("last_message_must_be_user");
  return { ok: true, messages: validated };
}

function sseLine(event: ChatGroundingEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Drive the engine's grounding stream and re-emit each event as one SSE `data:` line. Factored out of the
 *  plugin so tests assert the exact wire framing against an injected fake stream. */
export async function* streamChatSse(messages: ChatMessage[], deps: ChatApiDeps = defaultDeps): AsyncGenerator<string> {
  const { streamChatGrounding } = await deps.loadChatGroundingModule();
  for await (const event of streamChatGrounding({ messages, env: deps.env })) {
    yield sseLine(event);
  }
}

type MiddlewareReq = { method?: string; url?: string } & NodeJS.ReadableStream;
type MiddlewareRes = {
  statusCode: number;
  setHeader: (key: string, value: string) => void;
  write: (chunk: string) => void;
  end: (body?: string) => void;
};

function readRequestBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Vite dev/preview middleware for the streaming local chat endpoint. */
export function chatApiPlugin(deps: ChatApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (fn: (req: MiddlewareReq, res: MiddlewareRes, next: () => void) => void) => void;
  }) => {
    middlewares.use((req, res, next) => {
      if (!isChatRoute(req.method, req.url)) return next();
      void readRequestBody(req).then(async (rawBody) => {
        const parsed = parseChatRequestBody(rawBody);
        if (!parsed.ok) {
          res.statusCode = parsed.status;
          res.setHeader("Content-Type", "application/json");
          res.end(parsed.body);
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        for await (const chunk of streamChatSse(parsed.messages, deps)) {
          res.write(chunk);
        }
        res.end();
      });
    });
  };
  return {
    name: "loopover-miner-ui:chat-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
