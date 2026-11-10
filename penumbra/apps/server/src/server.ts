import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, project, Projector, type DraftEvent, type LogEvent, type Millis, type PictureSnapshot } from "@penumbra/core";
import type { CompiledScenario } from "@penumbra/sim";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMsg, type ClockState, type ServerMsg } from "./protocol";

export interface ServerOptions {
  compiled: CompiledScenario;
  port?: number;
  host?: string;
  /** Wall-clock ms between simulation ticks. 0 disables the timer (drive with advance()). */
  tickMs?: number;
  /** Snapshots per wall-clock second pushed to each client. 0 disables the timer. */
  snapshotHz?: number;
  speed?: number;
  autoplay?: boolean;
}

interface Client {
  ws: WebSocket;
  view: "live" | Millis;
}

const MAX_SPEED = 16;
const CHUNK = 2000;

const stripSeq = (e: LogEvent): DraftEvent => {
  const { seq: _seq, ...rest } = e;
  return rest as DraftEvent;
};

/**
 * Server-authoritative feed. Owns the live log: scenario events are published
 * as the simulation clock passes them, operator actions are appended at the
 * head. Sequence numbers are assigned in publication order, so a run with no
 * live actions reproduces the compiled stream exactly.
 */
export class PenumbraServer {
  private readonly compiled: CompiledScenario;
  private readonly opts: Required<Omit<ServerOptions, "compiled">>;
  private log = new EventLog();
  /** Folded state of the live log, so a live snapshot only costs an evaluation. */
  private projector = new Projector();
  private pending = 0;
  private head: Millis;
  private playing: boolean;
  private speed: number;
  private readonly clients = new Set<Client>();
  private http?: Server;
  private wss?: WebSocketServer;
  private tickTimer?: NodeJS.Timeout;
  private snapTimer?: NodeJS.Timeout;
  private liveCache?: { seq: number; t: Millis; snapshot: PictureSnapshot };

  constructor(options: ServerOptions) {
    this.compiled = options.compiled;
    this.opts = {
      port: options.port ?? 8787,
      host: options.host ?? "127.0.0.1",
      tickMs: options.tickMs ?? 100,
      snapshotHz: options.snapshotHz ?? 4,
      speed: options.speed ?? 1,
      autoplay: options.autoplay ?? true,
    };
    this.head = this.compiled.meta.playFrom;
    this.playing = this.opts.autoplay;
    this.speed = this.opts.speed;
    this.reset();
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<{ port: number; url: string }> {
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    if (this.opts.tickMs > 0) {
      this.tickTimer = setInterval(() => {
        if (this.playing) this.advance(this.opts.tickMs * this.speed);
      }, this.opts.tickMs);
    }
    if (this.opts.snapshotHz > 0) {
      this.snapTimer = setInterval(() => this.pushSnapshots(), 1000 / this.opts.snapshotHz);
    }
    const { port } = this.http.address() as AddressInfo;
    return { port, url: `ws://${this.opts.host}:${port}/ws` };
  }

  async stop(): Promise<void> {
    clearInterval(this.tickTimer);
    clearInterval(this.snapTimer);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  // ------------------------------------------------------------------ simulation

  get clock(): ClockState {
    return { head: this.head, playing: this.playing, speed: this.speed, ended: this.head >= this.compiled.meta.end };
  }

  get events(): readonly LogEvent[] {
    return this.log.all();
  }

  /** Move the live head forward by `dtMs` of simulation time and publish what it passes. */
  advance(dtMs: number): LogEvent[] {
    if (dtMs <= 0 || this.head >= this.compiled.meta.end) return [];
    this.head = Math.min(this.compiled.meta.end, this.head + dtMs);
    const published = this.publishUpTo(this.head);
    if (published.length) this.broadcast({ type: "events", events: published });
    if (this.head >= this.compiled.meta.end && this.playing) {
      this.playing = false;
      this.broadcast({ type: "clock", clock: this.clock });
    }
    return published;
  }

  /** Picture at the live head (cached per log state). */
  liveSnapshot(): PictureSnapshot {
    const c = this.liveCache;
    if (c && c.seq === this.log.lastSeq && c.t === this.head) return c.snapshot;
    const snapshot = this.projector.evaluate(this.head);
    this.liveCache = { seq: this.log.lastSeq, t: this.head, snapshot };
    return snapshot;
  }

  /** Picture as it stood at a past moment, from the log alone. */
  snapshotAt(t: Millis): PictureSnapshot {
    return project(this.log.all(), Math.min(t, this.head));
  }

  private reset() {
    this.log = new EventLog();
    this.projector = new Projector();
    this.pending = 0;
    this.head = this.compiled.meta.playFrom;
    this.liveCache = undefined;
    this.publishUpTo(this.head);
  }

  private publishUpTo(t: Millis): LogEvent[] {
    const out: LogEvent[] = [];
    const src = this.compiled.events;
    while (this.pending < src.length && src[this.pending]!.t <= t) {
      const ev = this.log.append(stripSeq(src[this.pending]!));
      this.projector.apply(ev);
      out.push(ev);
      this.pending++;
    }
    return out;
  }

  // ------------------------------------------------------------------ messaging

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, view: "live" };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
    ws.on("message", (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data)) as ClientMsg;
      } catch {
        this.send(client, { type: "error", message: "message is not valid JSON" });
        return;
      }
      this.onMessage(client, msg);
    });
    this.send(client, { type: "hello", protocol: PROTOCOL_VERSION, meta: this.compiled.meta, clock: this.clock, lastSeq: this.log.lastSeq });
    this.sendLog(client, this.log.all(), true);
    this.send(client, { type: "snapshot", view: "live", snapshot: this.liveSnapshot() });
  }

  private onMessage(client: Client, msg: ClientMsg) {
    const rid = "requestId" in msg && typeof msg.requestId === "string" ? { requestId: msg.requestId } : {};
    const fail = (message: string) => this.send(client, { type: "error", ...rid, message });
    switch (msg?.type) {
      case "control": {
        if (msg.command === "play") this.playing = this.head < this.compiled.meta.end;
        else if (msg.command === "pause") this.playing = false;
        else if (msg.command === "speed") {
          if (typeof msg.speed !== "number" || !(msg.speed > 0) || msg.speed > MAX_SPEED) return fail(`speed must be in (0, ${MAX_SPEED}]`);
          this.speed = msg.speed;
        } else if (msg.command === "restart") {
          this.reset();
          for (const c of this.clients) {
            c.view = "live";
            this.sendLog(c, this.log.all(), true);
          }
        } else return fail(`unknown control command "${String((msg as { command?: unknown }).command)}"`);
        this.send(client, { type: "ack", ...rid });
        this.broadcast({ type: "clock", clock: this.clock });
        this.pushSnapshots();
        return;
      }
      case "view": {
        if (msg.t === "live") client.view = "live";
        else if (typeof msg.t === "number" && Number.isFinite(msg.t)) client.view = Math.max(this.compiled.meta.logStart, Math.min(msg.t, this.head));
        else return fail('view.t must be "live" or a time in ms');
        this.send(client, { type: "ack", ...rid });
        this.sendSnapshot(client);
        return;
      }
      case "sync": {
        if (typeof msg.fromSeq !== "number") return fail("sync.fromSeq must be a number");
        this.sendLog(client, this.log.since(msg.fromSeq), false);
        this.send(client, { type: "ack", ...rid });
        return;
      }
      case "operator_action": {
        const problem = this.validateAction(msg);
        if (problem) return fail(problem);
        const draft: DraftEvent = {
          kind: "operator_action",
          t: this.head,
          operatorId: msg.operatorId,
          action: msg.action,
          entityId: msg.entityId,
          dimension: msg.dimension,
          ...(msg.action === "resolve" ? { value: msg.value! } : {}),
        };
        const ev = this.log.append(draft);
        this.projector.apply(ev);
        this.broadcast({ type: "events", events: [ev] });
        this.send(client, { type: "ack", ...rid, seq: ev.seq });
        this.pushSnapshots();
        return;
      }
      default:
        return fail(`unknown message type "${String((msg as { type?: unknown })?.type)}"`);
    }
  }

  private validateAction(msg: ClientMsg & { type: "operator_action" }): string | undefined {
    if (typeof msg.operatorId !== "string" || !msg.operatorId) return "operatorId is required";
    if (msg.action !== "resolve" && msg.action !== "defer") return "action must be resolve or defer";
    if (typeof msg.entityId !== "string" || typeof msg.dimension !== "string") return "entityId and dimension are required";
    const c = this.liveSnapshot().contradictions.find((x) => x.entityId === msg.entityId && x.dimension === msg.dimension);
    if (!c) return `no contradiction on ${msg.entityId} ${msg.dimension}`;
    if (c.status === "resolved") return `${c.id} is already resolved`;
    if (msg.action === "resolve" && !c.hypotheses.some((h) => h.value === msg.value)) {
      return `resolve value must be one of: ${c.hypotheses.map((h) => h.value).join(", ")}`;
    }
    return undefined;
  }

  private pushSnapshots() {
    for (const c of this.clients) this.sendSnapshot(c);
  }

  private sendSnapshot(c: Client) {
    const snapshot = c.view === "live" ? this.liveSnapshot() : this.snapshotAt(c.view);
    this.send(c, { type: "snapshot", view: c.view, snapshot });
  }

  private sendLog(c: Client, events: readonly LogEvent[], reset: boolean) {
    if (events.length === 0) {
      this.send(c, { type: "events", events: [], ...(reset ? { reset } : {}) });
      return;
    }
    for (let i = 0; i < events.length; i += CHUNK) {
      this.send(c, { type: "events", events: events.slice(i, i + CHUNK), ...(reset && i === 0 ? { reset } : {}) });
    }
  }

  private send(c: Client, msg: ServerMsg) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  // ------------------------------------------------------------------ http

  private handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, scenario: this.compiled.meta.id, clock: this.clock, lastSeq: this.log.lastSeq }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/log.jsonl") {
      // The full append-only log: everything needed to reconstruct any picture this run showed.
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(this.log.all().map((e) => JSON.stringify(e)).join("\n") + "\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  }
}
