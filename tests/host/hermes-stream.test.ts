// Hermes: the api_server's OpenAI-compatible SSE mapped into the host's events.
// A fake SSE server on localhost (node:http, an ephemeral port), the adapter driven directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HermesAdapter } from "../../host/providers/hermes/adapter.ts";
import type { AdapterHost, NormalizedEvent, PromptMode } from "../../host/providers/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(f: () => boolean, what = "condition", timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

type Request = { url: string; auth: string | null; body: any };

/** A fake Hermes api_server: records requests, answers with whatever `handle` writes. */
async function fakeApi(): Promise<{ url: string; requests: Request[]; disconnects: number; handle: (res: ServerResponse) => void; stop(): Promise<void> }> {
  const requests: Request[] = [];
  let disconnects = 0;
  let handle: (res: ServerResponse) => void = (res) => res.end("{}");
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    res.on("close", () => {
      if (!res.writableEnded) disconnects++;
    });
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(data || "{}");
      } catch {
        body = data;
      }
      requests.push({ url: req.url ?? "", auth: req.headers.authorization ?? null, body });
      res.setHeader("content-type", "application/json");
      handle(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    get disconnects() {
      return disconnects;
    },
    set handle(h: (res: ServerResponse) => void) {
      handle = h;
    },
    get handle() {
      return handle;
    },
    stop: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

const sse = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sseDone = (res: ServerResponse) => res.write("data: [DONE]\n\n");

async function hermes(command: string) {
  const events: NormalizedEvent[] = [];
  const host: AdapterHost = { emit: (ev) => events.push(ev), log: () => {}, running: false, working: false };
  const adapter = new HermesAdapter({ cwd: process.cwd(), command, args: [], log: () => {} });
  await adapter.start(null, host);
  return { adapter, events, types: () => events.map((e) => e.type) };
}

const prompt = { images: [] as never[], mode: "auto" as PromptMode };

test("hermes: a streaming turn maps SSE deltas into the host's events", async () => {
  const api = await fakeApi();
  const wasKey = process.env.HERDR_CHAT_HERMES_API_KEY;
  process.env.HERDR_CHAT_HERMES_API_KEY = "test-key"; // the api_server's key, if it wants one
  try {
    api.handle = async (res) => {
      res.setHeader("content-type", "text/event-stream");
      sse(res, { choices: [{ delta: { content: "Hello" } }] });
      await sleep(20);
      sse(res, { choices: [{ delta: { content: " world" } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      sseDone(res);
      res.end();
    };
    const { adapter, events, types } = await hermes(api.url);
    await adapter.prompt({ ...prompt, id: "m1", text: "hi", busy: false });
    await waitUntil(() => events.some((e) => e.type === "run_settled"), "run to settle");
    assert.deepEqual(types(), [
      "model", "user_message", "run_started", "assistant_start", "assistant_block_start",
      "assistant_delta", "assistant_delta", "assistant_block_end", "assistant_end", "run_settled",
    ]);
    const echo = events.find((e) => e.type === "user_message")!;
    assert.deepEqual({ text: echo.text, images: echo.images, clientId: echo.clientId }, { text: "hi", images: 0, clientId: "m1" });
    const deltas = events.filter((e) => e.type === "assistant_delta");
    assert.deepEqual(deltas.map((d) => d.delta), ["Hello", " world"]);
    const end = events.find((e) => e.type === "assistant_end")!;
    assert.deepEqual(end.content, [{ type: "text", text: "Hello world" }]);
    assert.equal(end.stopReason, "stop");
    assert.equal(end.model, "hermes/hermes-agent");
    assert.deepEqual(events.find((e) => e.type === "run_settled"), { type: "run_settled", aborted: false });
    // The request the host made: the api_server's OpenAI-compatible endpoint.
    assert.deepEqual(api.requests.map((r) => r.url), ["/v1/chat/completions"]);
    assert.equal(api.requests[0]!.auth, "Bearer test-key");
    assert.equal(api.requests[0]!.body.model, "hermes-agent");
    assert.equal(api.requests[0]!.body.stream, true);
    assert.deepEqual(api.requests[0]!.body.messages, [{ role: "user", content: "hi" }]);
    await adapter.dispose();
  } finally {
    if (wasKey === undefined) delete process.env.HERDR_CHAT_HERMES_API_KEY;
    else process.env.HERDR_CHAT_HERMES_API_KEY = wasKey;
    await api.stop();
  }
});

test("hermes: an error response surfaces as the run's error, and an SSE error payload too", async () => {
  const api = await fakeApi();
  try {
    api.handle = (res) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "nope" } }));
    };
    const { adapter, events } = await hermes(api.url);
    await adapter.prompt({ ...prompt, id: "m1", text: "first", busy: false });
    await waitUntil(() => events.some((e) => e.type === "run_settled"), "error run to settle");
    const end = events.find((e) => e.type === "assistant_end")!;
    assert.equal(end.stopReason, "error");
    assert.match(end.error ?? "", /nope/);
    assert.deepEqual(events.find((e) => e.type === "run_settled"), { type: "run_settled", aborted: false });
    // An error payload in the stream itself.
    api.handle = (res) => {
      res.setHeader("content-type", "text/event-stream");
      sse(res, { error: { message: "sse boom" } });
      res.end();
    };
    await adapter.prompt({ ...prompt, id: "m2", text: "again", busy: false });
    await waitUntil(() => events.filter((e) => e.type === "assistant_end").length === 2, "second error run to settle");
    const second = events.filter((e) => e.type === "assistant_end")[1]!;
    assert.equal(second.stopReason, "error");
    assert.match(second.error ?? "", /sse boom/);
    // A failed turn left nothing in the conversation: the next request starts over.
    assert.deepEqual(api.requests[1]!.body.messages, [{ role: "user", content: "again" }]);
    await adapter.dispose();
  } finally {
    await api.stop();
  }
});

test("hermes: abort mid-stream stops the turn and drops the connection", async () => {
  const api = await fakeApi();
  try {
    api.handle = (res) => {
      res.setHeader("content-type", "text/event-stream");
      sse(res, { choices: [{ delta: { content: "Half" } }] }); // then it holds the stream open
    };
    const { adapter, events } = await hermes(api.url);
    await adapter.prompt({ ...prompt, id: "m1", text: "hi", busy: false });
    await waitUntil(() => events.some((e) => e.type === "assistant_delta"), "the first delta");
    adapter.abort();
    await waitUntil(() => events.some((e) => e.type === "run_settled"), "the aborted run to settle");
    const end = events.find((e) => e.type === "assistant_end")!;
    assert.equal(end.stopReason, "aborted");
    assert.deepEqual(end.content, [{ type: "text", text: "Half" }]);
    assert.deepEqual(events.find((e) => e.type === "run_settled"), { type: "run_settled", aborted: true });
    await waitUntil(() => api.disconnects > 0, "the api_server to see the disconnect");
    await adapter.dispose();
  } finally {
    await api.stop();
  }
});

test("hermes: a message sent while it works is queued, then sent with the conversation so far", async () => {
  const api = await fakeApi();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    api.handle = async (res) => {
      res.setHeader("content-type", "text/event-stream");
      const first = calls++ === 0;
      sse(res, { choices: [{ delta: { content: first ? "one" : "two" } }] });
      if (first) await gate;
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      sseDone(res);
      res.end();
    };
    const { adapter, events } = await hermes(api.url);
    await adapter.prompt({ ...prompt, id: "m1", text: "first", busy: false });
    await waitUntil(() => events.some((e) => e.type === "assistant_delta"), "the first delta");
    // Busy: the second message waits for the run to end.
    const queued = await adapter.prompt({ ...prompt, id: "m2", text: "second", busy: true });
    assert.deepEqual(queued, { disposition: "queued" });
    const q = events.find((e) => e.type === "queue_changed")!;
    assert.deepEqual({ steering: q.steering, followUp: q.followUp, followUpIds: q.followUpIds }, { steering: [], followUp: ["second"], followUpIds: ["m2"] });
    release();
    await waitUntil(() => events.filter((e) => e.type === "run_settled").length === 2, "both runs to settle");
    // The queued message went out with the whole conversation.
    assert.deepEqual(api.requests[1]!.body.messages, [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
    ]);
    // And the queue is empty again.
    const last = events.filter((e) => e.type === "queue_changed").at(-1)!;
    assert.deepEqual({ steering: last.steering, followUp: last.followUp }, { steering: [], followUp: [] });
    assert.deepEqual(await adapter.clearQueue(), [], "nothing left to clear");
    await adapter.dispose();
  } finally {
    await api.stop();
  }
});

test("hermes: without a base URL configured, start says how to configure it", async () => {
  const api = await fakeApi();
  const wasUrl = process.env.HERDR_CHAT_HERMES_URL;
  const wasCmd = process.env.HERDR_CHAT_HERMES;
  try {
    delete process.env.HERDR_CHAT_HERMES_URL;
    delete process.env.HERDR_CHAT_HERMES;
    const host: AdapterHost = { emit: () => {}, log: () => {}, running: false, working: false };
    const adapter = new HermesAdapter({ cwd: process.cwd(), command: "", args: [], log: () => {} });
    await assert.rejects(() => adapter.start(null, host), /HERDR_CHAT_HERMES_URL/);
    // The environment variable is the other way to point it at an api_server.
    process.env.HERDR_CHAT_HERMES_URL = api.url;
    api.handle = (res) => {
      res.setHeader("content-type", "text/event-stream");
      sse(res, { choices: [{ delta: { content: "ok" } }] });
      sseDone(res);
      res.end();
    };
    const events: NormalizedEvent[] = [];
    const envAdapter = new HermesAdapter({ cwd: process.cwd(), command: "", args: [], log: () => {} });
    await envAdapter.start(null, { ...host, emit: (ev) => events.push(ev) });
    await envAdapter.prompt({ ...prompt, id: "m1", text: "hi", busy: false });
    await waitUntil(() => events.some((e) => e.type === "run_settled"), "the env-configured run to settle");
    assert.equal(api.requests.length, 1);
    await envAdapter.dispose();
  } finally {
    if (wasUrl === undefined) delete process.env.HERDR_CHAT_HERMES_URL;
    else process.env.HERDR_CHAT_HERMES_URL = wasUrl;
    if (wasCmd === undefined) delete process.env.HERDR_CHAT_HERMES;
    else process.env.HERDR_CHAT_HERMES = wasCmd;
    await api.stop();
  }
});
