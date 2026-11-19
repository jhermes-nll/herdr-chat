// Hermes: an OpenAI-compatible api_server, not a local CLI (docs/dev/providers.md "Hermes").
// v1 is text in, streamed text out, stop: every capability it doesn't have is
// declared absent, so the chat hides it. The api_server is stateless, so the
// adapter keeps the conversation itself; there are no session files (no /resume,
// no /fork, no TUI hand-off). Its base URL: the `--hermes <url>` serve flag
// (also $HERDR_CHAT_HERMES), else $HERDR_CHAT_HERMES_URL — never guessed: a
// Hermes is wherever the person runs it.
import { NO_TOOLS } from "../../tools.ts";
import type {
  AgentCommand, AgentModel, AdapterHost, AdapterOptions, AskAnswer, Capabilities, Disposition, NormalizedEvent,
  ProviderAdapter, PromptMode, SessionSource, StartInfo, UsageInfo,
} from "../types.ts";
import type { StopReason } from "../../timeline.ts";

const MODEL = "hermes-agent";
const STOP_REASONS = new Set<string>(["stop", "length", "toolUse", "error", "aborted"]);

/** One queued message: sent when the run it waited for ends. */
type Held = { id: string; text: string };

export class HermesAdapter implements ProviderAdapter {
  readonly id = "hermes" as const;
  readonly name = "Hermes";
  readonly tools = NO_TOOLS;
  readonly capabilities: Capabilities = {
    steer: false, followUp: true, thinkingLevels: [], permissions: false, permissionModes: [],
    extensionUi: false, compact: false, compactInstructions: false, rename: false, fork: false,
    images: false, cost: false, tui: false,
  };
  private opts: AdapterOptions;
  private host: AdapterHost | null = null;
  private disposed = false;
  /** The in-flight request's cancel. */
  private run: AbortController | null = null;
  /** The conversation this chat has had (the api_server is stateless). */
  private messages: { role: "user" | "assistant"; content: string }[] = [];
  private pending: Held[] = [];
  /** The queue length last announced, so an unchanged queue emits nothing. */
  private queueShown = 0;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  /** `--hermes <url>` / $HERDR_CHAT_HERMES, else $HERDR_CHAT_HERMES_URL; null when neither is one. */
  private get baseUrl(): string | null {
    const from = [this.opts.command, process.env.HERDR_CHAT_HERMES_URL].find((v) => typeof v === "string" && /^https?:\/\//i.test(v));
    return from ? from.replace(/\/+$/, "") : null;
  }

  private get apiKey(): string | null {
    return process.env.HERDR_CHAT_HERMES_API_KEY ?? null;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  get alive(): boolean {
    return !!this.host && !this.disposed;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(_session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.disposed = false;
    if (!this.baseUrl) {
      throw new Error("Hermes needs its api_server's base URL: set HERDR_CHAT_HERMES_URL (or pass --hermes <url>, or set HERDR_CHAT_HERMES), e.g. http://<host>:<port>");
    }
    if (this.messages.length === 0) this.emit({ type: "model", model: this.modelInfo() });
    return { streaming: false, hasHistory: this.messages.length > 0 };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.run?.abort();
    this.pending = [];
    await new Promise((r) => setTimeout(r, 0)); // let the aborted turn emit run_settled
  }

  kill(): void {
    this.disposed = true;
    this.run?.abort();
  }

  // ---------------------------------------------------------------- turns

  async prompt(p: { id: string; text: string; images: never[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    if (!this.host) throw new Error("Hermes is not running. Use /reload to restart it.");
    if (p.images.length) throw new Error("Hermes takes text only.");
    if (this.run) {
      this.pending.push({ id: p.id, text: p.text });
      this.emitQueue();
      return { disposition: "queued" };
    }
    void this.turn(p.id, p.text);
    return { disposition: "started" };
  }

  private emitQueue(): void {
    if (this.pending.length === this.queueShown) return;
    this.queueShown = this.pending.length;
    this.emit({ type: "queue_changed", steering: [], followUp: this.pending.map((m) => m.text), followUpIds: this.pending.map((m) => m.id) });
  }

  async clearQueue(): Promise<string[]> {
    const texts = this.pending.map((m) => m.text);
    if (!texts.length) return texts;
    this.pending = [];
    this.emitQueue();
    return texts;
  }

  abort(): void {
    this.run?.abort();
  }

  answer(_askId: string, _a: AskAnswer): void {}

  /** One streamed request: user echo, run, deltas, settle. Errors become the run's error, never a throw. */
  private async turn(id: string, text: string): Promise<void> {
    const host = this.host!;
    host.emit({ type: "user_message", text, images: 0, clientId: id });
    host.emit({ type: "run_started" });
    host.emit({ type: "assistant_start" });
    const messages = [...this.messages, { role: "user" as const, content: text }];
    const ac = new AbortController();
    this.run = ac;
    let streamed = ""; // what the run showed so far (also what an abort keeps)
    let block = false; // the text block began
    let stop: StopReason | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: MODEL, stream: true, messages }),
        signal: ac.signal,
      });
      if (!res.ok) {
        error = `HTTP ${res.status}: ${errorText(await res.text().catch(() => ""))}`;
      } else if (res.body) {
        // SSE: `data: {...}` lines, `[DONE]` sentinel. An unrecognised event is ignored.
        // One decoder for the stream: a multi-byte character split across reads
        // would be two U+FFFDs if each chunk were decoded on its own.
        const dec = new TextDecoder();
        // One `data:` line → a delta, a finish, or an error. Returns true: stop reading.
        const onLine = (line: string): boolean => {
          if (!line.startsWith("data:")) return false;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return false;
          let ev: unknown;
          try {
            ev = JSON.parse(data);
          } catch {
            return false; // not JSON: ignored, the rest of the stream still maps
          }
          if (isRec(ev) && isRec(ev.error)) {
            error = errorText(JSON.stringify(ev));
            return true;
          }
          const choice = isRec(ev) && Array.isArray(ev.choices) && isRec(ev.choices[0]) ? ev.choices[0] : null;
          const delta = choice && isRec(choice.delta) && typeof choice.delta.content === "string" ? choice.delta.content : "";
          if (delta) {
            if (!block) {
              host.emit({ type: "assistant_block_start", index: 0, kind: "text" });
              block = true;
            }
            streamed += delta;
            host.emit({ type: "assistant_delta", index: 0, kind: "text", delta });
          }
          const reason = choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null;
          if (reason && STOP_REASONS.has(reason)) stop = reason as StopReason;
          return false;
        };
        let buf = "";
        let failed = false;
        for await (const chunk of res.body) {
          buf += dec.decode(chunk as Uint8Array, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          if (lines.some(onLine)) {
            failed = true;
            break;
          }
        }
        if (!failed) {
          buf += dec.decode(); // end of stream: flush a character split across reads
          // A last line the server never newline-terminated is still an event.
          for (const line of buf.split("\n")) if (onLine(line)) break;
        }
      }
    } catch (e) {
      stop = ac.signal.aborted ? "aborted" : null;
      if (!stop) error = e instanceof Error ? e.message : String(e);
    }
    if (error) stop = "error";
    if (block) host.emit({ type: "assistant_block_end", index: 0, kind: "text" });
    // Only a turn that finished (or aborted mid-text) is part of the conversation from here on;
    // a failed one leaves nothing, so a retry starts clean.
    if (stop !== "error") {
      this.messages = messages;
      if (streamed) this.messages.push({ role: "assistant", content: streamed });
    }
    host.emit({
      type: "assistant_end",
      content: block ? [{ type: "text", text: streamed }] : [],
      stopReason: stop ?? "stop",
      ...(error ? { error } : {}),
      model: `hermes/${MODEL}`,
    });
    this.run = null;
    host.emit({ type: "run_settled", aborted: stop === "aborted" });
    // A queued message goes out now the run is over.
    const next = this.pending.shift();
    if (next && !this.disposed) {
      this.emitQueue();
      void this.turn(next.id, next.text);
    } else this.emitQueue();
  }

  // ---------------------------------------------------------------- queries

  /** The conversation is in memory: this is what /reload rebuilds the timeline from. */
  async history(): Promise<NormalizedEvent[]> {
    const out: NormalizedEvent[] = [];
    for (const m of this.messages) {
      if (m.role === "user") {
        out.push({ type: "user_message", text: m.content, images: 0, source: "composer" });
        continue;
      }
      out.push(
        { type: "assistant_start" },
        { type: "assistant_block_start", index: 0, kind: "text" },
        { type: "assistant_delta", index: 0, kind: "text", delta: m.content },
        { type: "assistant_block_end", index: 0, kind: "text" },
        { type: "assistant_end", content: [{ type: "text", text: m.content }], stopReason: "stop", model: `hermes/${MODEL}` },
      );
    }
    return out;
  }

  readonly sessions: SessionSource = { kind: "files", files: () => [], describe: () => null };

  private modelInfo() {
    return { provider: "hermes", id: MODEL, name: "Hermes", reasoning: false, contextWindow: null, input: ["text"] };
  }

  async listModels(): Promise<AgentModel[]> {
    return [{ provider: "hermes", id: MODEL, name: "Hermes", reasoning: false, enabled: true }];
  }

  async commands(): Promise<AgentCommand[]> {
    return [];
  }

  async usage(): Promise<UsageInfo> {
    return { contextTokens: null, contextWindow: null, percent: null, cost: null };
  }

  tuiCommand(): string[] {
    return []; // capabilities.tui is false: never asked
  }

  // ---------------------------------------------------------------- settings and sessions

  async setModel(provider: string, id: string): Promise<void> {
    if (provider !== "hermes" || id !== MODEL) throw new Error(`Hermes runs one model: ${MODEL}`);
  }

  async newSession(): Promise<void> {
    this.messages = [];
    this.emit({ type: "session", id: null, file: null, name: null });
    this.emit({ type: "model", model: this.modelInfo() });
  }

  async switchSession(): Promise<void> {
    throw new Error("Hermes chats keep no session files to switch to.");
  }

  async setName(): Promise<void> {
    throw new Error("Hermes chats cannot be named.");
  }

  async setThinking(): Promise<void> {
    throw new Error("Hermes has no thinking levels.");
  }

  async setPermissionMode(): Promise<void> {
    throw new Error("Hermes has no permission modes.");
  }

  async compact(): Promise<void> {
    throw new Error("Hermes chats cannot be compacted.");
  }
}

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** An error body's message ("error.message"), else the body itself. */
function errorText(body: string): string {
  try {
    const j: unknown = JSON.parse(body);
    if (isRec(j)) {
      const err = isRec(j.error) ? j.error : j;
      const m = err.message;
      if (typeof m === "string" && m) return m;
    }
  } catch {
    // not JSON: the raw body below is the message
  }
  return body.slice(0, 200) || "error";
}
