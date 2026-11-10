/**
 * Session instrumentation: every operator interaction, timestamped, as JSONL.
 * Live: batched to the feed server (POST /api/sessions/:id). Offline: kept in
 * memory and offered as a download. Feeds after-action review and the
 * legibility probe report.
 */
export interface SessionContext {
  simT?: number;
  view: string;
  replay: boolean;
  mode: string;
}

export interface SessionEvent {
  session: string;
  seq: number;
  /** Wall clock, ISO 8601. */
  wall: string;
  /** Monotonic ms since the session started (for latencies). */
  ms: number;
  /** Simulation time on screen (ISO), if any. */
  sim?: string;
  view: string;
  replay: boolean;
  mode: string;
  kind: string;
  data?: Record<string, unknown>;
}

type Send = (url: string, body: string) => Promise<boolean>;

const defaultSend: Send = async (url, body) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body, keepalive: true });
    return r.ok;
  } catch {
    return false;
  }
};

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `S${stamp}-${rand}`;
}

export class SessionRecorder {
  readonly id: string;
  readonly events: SessionEvent[] = [];
  private seq = 0;
  private sent = 0;
  private remote = false;
  private readonly t0: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly context: () => SessionContext,
    opts: { id?: string; send?: Send; now?: () => number } = {},
  ) {
    this.id = opts.id ?? newSessionId();
    this.send = opts.send ?? defaultSend;
    this.now = opts.now ?? (() => performance.now());
    this.t0 = this.now();
  }

  private readonly send: Send;
  private readonly now: () => number;

  /** Start sending batches to the feed server every `everyMs`. */
  enableRemote(everyMs = 2000) {
    if (this.remote) return;
    this.remote = true;
    this.timer = setInterval(() => void this.flush(), everyMs);
  }

  log(kind: string, data?: Record<string, unknown>): SessionEvent {
    const c = this.context();
    const e: SessionEvent = {
      session: this.id,
      seq: ++this.seq,
      wall: new Date().toISOString(),
      ms: Math.round(this.now() - this.t0),
      view: c.view,
      replay: c.replay,
      mode: c.mode,
      kind,
    };
    if (c.simT !== undefined) e.sim = new Date(c.simT).toISOString();
    if (data) e.data = data;
    this.events.push(e);
    return e;
  }

  /** Send everything not yet sent. Unsent events stay queued after a failure. */
  async flush(): Promise<void> {
    if (!this.remote || this.sent >= this.events.length) return;
    const batch = this.events.slice(this.sent);
    const ok = await this.send(`/api/sessions/${encodeURIComponent(this.id)}`, batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (ok) this.sent += batch.length;
  }

  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : "");
  }

  /** Offer the log as a file download (browser only). */
  download(name = `${this.id}.jsonl`) {
    const url = URL.createObjectURL(new Blob([this.toJSONL()], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }
}
