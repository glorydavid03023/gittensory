import { describe, expect, it } from "vitest";

import { CHAT_API_PATH, streamChat, type ChatWireMessage } from "./lib/chat-stream";

/** Build a fake `text/event-stream` Response whose body streams the given raw SSE chunks (each may hold part of,
 *  one, or several `data:` frames — the point is to exercise the client's frame reassembly). */
function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of stream) out.push(delta);
  return out;
}

const HI: ChatWireMessage[] = [{ role: "user", content: "hi" }];

describe("streamChat (#6518)", () => {
  it("yields each text delta, stops at the done event, and POSTs the messages to /api/chat", async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const chunks = await collect(
      streamChat(HI, async (input, requestInit) => {
        url = input;
        init = requestInit;
        return sseResponse([
          'data: {"type":"text","text":"Hel"}\n\n',
          'data: {"type":"text","text":"lo"}\n\n',
          'data: {"type":"done"}\n\n',
          'data: {"type":"text","text":"AFTER-DONE"}\n\n', // never reached: done ends the stream
        ]);
      }),
    );
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(url).toBe(CHAT_API_PATH);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ messages: HI });
  });

  it("consumes and skips grounding tool events, yielding only display text", async () => {
    const chunks = await collect(
      streamChat(HI, async () =>
        sseResponse([
          'data: {"type":"tool_call","tool":"loopover_miner_run_state","input":{}}\n\n',
          'data: {"type":"text","text":"A"}\n\n',
          'data: {"type":"tool_result","tool":"loopover_miner_run_state","output":{}}\n\n',
          'data: {"type":"text","text":"B"}\n\n',
          'data: {"type":"done"}\n\n',
        ]),
      ),
    );
    expect(chunks).toEqual(["A", "B"]);
  });

  it("reassembles a single event split across read boundaries", async () => {
    const chunks = await collect(
      streamChat(HI, async () =>
        sseResponse(['data: {"type":"te', 'xt","text":"split"}\n\n', 'data: {"type":"done"}\n\n']),
      ),
    );
    expect(chunks).toEqual(["split"]);
  });

  it("throws when the stream emits an error event", async () => {
    await expect(
      collect(
        streamChat(HI, async () =>
          sseResponse([
            'data: {"type":"text","text":"partial"}\n\n',
            'data: {"type":"error","code":"boom","message":"grounding failed"}\n\n',
          ]),
        ),
      ),
    ).rejects.toThrow(/grounding failed/);
  });

  it("throws before any delta on a non-2xx (validation) response", async () => {
    await expect(
      collect(streamChat([], async () => new Response(JSON.stringify({ error: "bad messages" }), { status: 400 }))),
    ).rejects.toThrow(/400/);
  });
});
