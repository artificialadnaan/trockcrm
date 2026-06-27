import { describe, it, expect } from "vitest";
import type { Response } from "express";
import { parseAnthropicSse, streamAiChat } from "./anthropic-stream.js";

function chunksOf(text: string, pieces = 1): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder().encode(text);
  const size = Math.ceil(enc.length / pieces);
  return (async function* () {
    for (let i = 0; i < enc.length; i += size) yield enc.subarray(i, i + size);
  })();
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function bodyFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function fakeRes() {
  const writes: string[] = [];
  let ended = false;
  const res = {
    write: (s: string) => { writes.push(s); return true; },
    flush: () => {},
    end: () => { ended = true; },
  } as unknown as Response;
  // parse emitted client events (skip the padding comment)
  const events = () =>
    writes
      .filter((w) => w.startsWith("event:"))
      .map((w) => {
        const ev = w.match(/^event: (.*)$/m)?.[1] ?? "";
        const data = JSON.parse(w.match(/^data: (.*)$/m)?.[1] ?? "null");
        return { event: ev, data };
      });
  return { res, events, ended: () => ended };
}

describe("parseAnthropicSse", () => {
  it("parses frames even when split across chunk boundaries", async () => {
    const text = sse([
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    ]);
    const got: string[] = [];
    for await (const evt of parseAnthropicSse(chunksOf(text, 7))) got.push(evt.type);
    expect(got).toEqual(["message_start", "content_block_start", "content_block_delta"]);
  });
});

describe("streamAiChat", () => {
  const baseOpts = { messages: [{ role: "user" as const, content: "hi" }], system: "sys", mcpUrl: "https://x/mcp", mcpToken: "t", apiKey: "k" };

  it("streams meta → text → done for a simple turn", async () => {
    const stream = sse([
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello there" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]);
    const fetchImpl = (async () => ({ ok: true, status: 200, body: bodyFrom(stream) })) as unknown as typeof fetch;
    const { res, events, ended } = fakeRes();

    await streamAiChat(res, { ...baseOpts, fetchImpl });

    const evs = events();
    expect(evs[0].event).toBe("meta");
    expect(evs.filter((e) => e.event === "text").map((e) => e.data.delta).join("")).toBe("Hello there");
    const done = evs.at(-1);
    expect(done?.event).toBe("done");
    expect(done?.data.stopReason).toBe("end_turn");
    expect(ended()).toBe(true);
  });

  it("continues across a pause_turn (re-POSTs, single terminal done)", async () => {
    const paused = sse([
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working..." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" } },
    ]);
    const finished = sse([
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done!" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: bodyFrom(calls === 1 ? paused : finished) };
    }) as unknown as typeof fetch;
    const { res, events } = fakeRes();

    await streamAiChat(res, { ...baseOpts, fetchImpl });

    expect(calls).toBe(2);
    const evs = events();
    expect(evs.filter((e) => e.event === "text").map((e) => e.data.delta).join("")).toBe("working...done!");
    expect(evs.filter((e) => e.event === "done")).toHaveLength(1);
    expect(evs.at(-1)?.data.stopReason).toBe("end_turn");
  });

  it("fails loudly (error + done) when the pause_turn continuation cap is exhausted", async () => {
    const paused = sse([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "..." } },
      { type: "message_delta", delta: { stop_reason: "pause_turn" } },
    ]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: bodyFrom(paused) };
    }) as unknown as typeof fetch;
    const { res, events } = fakeRes();

    await streamAiChat(res, { ...baseOpts, fetchImpl });

    expect(calls).toBeGreaterThan(1); // it kept continuing until the cap
    const evs = events();
    expect(evs.some((e) => e.event === "error")).toBe(true);
    expect(evs.at(-1)?.event).toBe("done");
    expect(evs.at(-1)?.data.stopReason).toBe("pause_turn");
  });

  it("emits an error frame + done when the API responds non-OK", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, body: null })) as unknown as typeof fetch;
    const { res, events } = fakeRes();
    await streamAiChat(res, { ...baseOpts, fetchImpl });
    const evs = events();
    expect(evs.some((e) => e.event === "error")).toBe(true);
    expect(evs.at(-1)?.event).toBe("done");
  });
});
