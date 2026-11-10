import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { clockToMillis } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { DEFAULT_SCENARIO } from "../src/paths";
import type { ClientMsg, ServerMsg, SnapshotMsg } from "@penumbra/sim";
import { PenumbraServer } from "../src/server";

const def = loadScenarioFile(DEFAULT_SCENARIO);
const at = (clock: string) => clockToMillis(def.date, clock);

class TestClient {
  readonly messages: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }
  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    const c = new TestClient(ws);
    await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
    return c;
  }
  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }
  /** Next matching message, including one already received after `fromIndex`. */
  next<T extends ServerMsg>(pred: (m: ServerMsg) => m is T, fromIndex = 0): Promise<T> {
    const seen = this.messages.slice(fromIndex).find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m as T)) });
    });
  }
  async request(m: ClientMsg & { requestId: string }): Promise<ServerMsg> {
    const from = this.messages.length;
    this.send(m);
    return this.next((x): x is ServerMsg => (x.type === "ack" || x.type === "error") && x.requestId === m.requestId, from);
  }
  async snapshotAfter(fn: () => void): Promise<SnapshotMsg> {
    const from = this.messages.length;
    fn();
    return this.next((x): x is SnapshotMsg => x.type === "snapshot", from);
  }
  close() {
    this.ws.close();
  }
}

let server: PenumbraServer | undefined;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await server?.stop();
  server = undefined;
});

async function boot(manualOperator = false) {
  const compiled = compileScenario(def, { manualOperator });
  server = new PenumbraServer({ compiled, port: 0, tickMs: 0, snapshotHz: 0, autoplay: false });
  const { url } = await server.start();
  const client = await TestClient.connect(url);
  clients.push(client);
  await client.next((m): m is SnapshotMsg => m.type === "snapshot"); // greeting complete
  return { compiled, server, client, url };
}

describe("PenumbraServer", () => {
  it("greets a client with the scenario, the published log and a live snapshot", async () => {
    const { client, compiled } = await boot();
    const hello = await client.next((m): m is Extract<ServerMsg, { type: "hello" }> => m.type === "hello");
    expect(hello.meta.id).toBe("ber-south-uas-surge");
    expect(hello.clock.head).toBe(compiled.meta.playFrom);
    const events = await client.next((m): m is Extract<ServerMsg, { type: "events" }> => m.type === "events");
    expect(events.reset).toBe(true);
    expect(events.events.length).toBe(compiled.events.filter((e) => e.t <= compiled.meta.playFrom).length);
    const snap = await client.next((m): m is SnapshotMsg => m.type === "snapshot");
    expect(snap.view).toBe("live");
    expect(snap.snapshot.t).toBe(compiled.meta.playFrom);
  });

  it("publishes scenario events as the clock passes them, reproducing the compiled stream", async () => {
    const { server, client, compiled } = await boot();
    const from = client.messages.length;
    server.advance(at("14:41:22") - compiled.meta.playFrom);
    await client.next((m): m is Extract<ServerMsg, { type: "events" }> => m.type === "events", from);
    const expected = compiled.events.filter((e) => e.t <= at("14:41:22"));
    expect(server.events).toEqual(expected);
    expect(server.liveSnapshot().contradictions.find((c) => c.id === "CTR-004")!.status).toBe("unresolved");
  });

  it("stops at the end of the scenario", async () => {
    const { server, compiled } = await boot();
    server.advance(10 * 60 * 1000);
    expect(server.clock.head).toBe(compiled.meta.end);
    expect(server.clock.ended).toBe(true);
    expect(server.advance(1000)).toEqual([]);
  });

  it("serves the picture at a past moment for scrubbing, and returns to live", async () => {
    const { server, client } = await boot();
    server.advance(at("14:41:22") - at("14:38:22"));
    const past = await client.snapshotAfter(() => client.send({ type: "view", t: at("14:36:00") }));
    expect(past.view).toBe(at("14:36:00"));
    expect(past.snapshot.t).toBe(at("14:36:00"));
    expect(past.snapshot.contradictions.map((c) => c.id)).toEqual(["CTR-003"]); // CTR-004 did not exist yet
    const live = await client.snapshotAfter(() => client.send({ type: "view", t: "live" }));
    expect(live.snapshot.t).toBe(at("14:41:22"));
  });

  it("clamps a scrub request to the live head (no peeking at the future)", async () => {
    const { client } = await boot();
    const snap = await client.snapshotAfter(() => client.send({ type: "view", t: at("14:41:50") }));
    expect(snap.snapshot.t).toBe(at("14:38:22"));
  });

  it("accepts a live operator resolution, appends it to the log and broadcasts it", async () => {
    const { server, client, url } = await boot(true);
    const other = await TestClient.connect(url);
    clients.push(other);
    await other.next((m): m is SnapshotMsg => m.type === "snapshot");
    server.advance(at("14:41:30") - at("14:38:22"));
    const fromOther = other.messages.length;
    const ack = await client.request({ type: "operator_action", requestId: "r1", operatorId: "OP-1", action: "resolve", entityId: "TRK-1155", dimension: "intent", value: "hobbyist" });
    expect(ack.type).toBe("ack");
    const seen = await other.next(
      (m): m is Extract<ServerMsg, { type: "events" }> => m.type === "events" && m.events.some((e) => e.kind === "operator_action"),
      fromOther,
    );
    const ev = seen.events[0]!;
    expect(ev).toMatchObject({ kind: "operator_action", t: at("14:41:30"), operatorId: "OP-1", value: "hobbyist" });
    expect((ack as { seq?: number }).seq).toBe(ev.seq);
    const c = server.liveSnapshot().contradictions.find((x) => x.id === "CTR-004")!;
    expect([c.status, c.actedBy]).toEqual(["resolved", "OP-1"]);
    // Scenario events published afterwards still get later sequence numbers.
    const after = server.advance(5000);
    expect(after.every((e) => e.seq > ev.seq)).toBe(true);
  });

  it("rejects actions that do not match a live contradiction", async () => {
    const { client } = await boot(true);
    const noCtr = await client.request({ type: "operator_action", requestId: "a", operatorId: "OP-1", action: "defer", entityId: "TRK-1160", dimension: "intent" });
    expect(noCtr).toMatchObject({ type: "error", message: "no contradiction on TRK-1160 intent" });
    const badValue = await client.request({ type: "operator_action", requestId: "b", operatorId: "OP-1", action: "resolve", entityId: "TRK-1147", dimension: "altitude_band", value: "space" });
    expect(badValue).toMatchObject({ type: "error" });
    expect((badValue as { message: string }).message).toMatch(/resolve value must be one of/);
  });

  it("restarts to the start of playback and resets every client's log", async () => {
    const { server, client } = await boot(true);
    server.advance(60_000);
    const from = client.messages.length;
    const ack = await client.request({ type: "control", requestId: "r", command: "restart" });
    expect(ack.type).toBe("ack");
    const reset = await client.next((m): m is Extract<ServerMsg, { type: "events" }> => m.type === "events" && m.reset === true, from);
    expect(reset.events.at(-1)!.t).toBeLessThanOrEqual(at("14:38:22"));
    expect(server.clock.head).toBe(at("14:38:22"));
  });

  it("validates control messages", async () => {
    const { client } = await boot();
    expect(await client.request({ type: "control", requestId: "s", command: "speed", speed: 99 })).toMatchObject({ type: "error" });
    expect(await client.request({ type: "control", requestId: "t", command: "speed", speed: 4 })).toMatchObject({ type: "ack" });
    client.ws.send("not json");
    await client.next((m): m is Extract<ServerMsg, { type: "error" }> => m.type === "error" && m.message === "message is not valid JSON");
  });

  it("re-sends missed events on sync", async () => {
    const { server, client } = await boot();
    const lastSeq = server.events.at(-1)!.seq;
    server.advance(30_000);
    const from = client.messages.length;
    await client.request({ type: "sync", requestId: "y", fromSeq: lastSeq });
    const batch = await client.next((m): m is Extract<ServerMsg, { type: "events" }> => m.type === "events" && m.events[0]?.seq === lastSeq + 1, from);
    expect(batch.events.at(-1)!.seq).toBe(server.events.at(-1)!.seq);
  });

  it("exports the append-only log over HTTP", async () => {
    const { server, url } = await boot();
    const base = url.replace("ws://", "http://").replace("/ws", "");
    const lines = (await (await fetch(`${base}/log.jsonl`)).text()).trim().split("\n");
    expect(lines.length).toBe(server.events.length);
    expect(JSON.parse(lines[0]!).kind).toBe("config");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("runs on its own timer when started normally", async () => {
    const compiled = compileScenario(def);
    server = new PenumbraServer({ compiled, port: 0, tickMs: 20, snapshotHz: 20, speed: 16, autoplay: true });
    const { url } = await server.start();
    const c = await TestClient.connect(url);
    clients.push(c);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.clock.head).toBeGreaterThan(compiled.meta.playFrom + 2000);
    expect(c.messages.filter((m) => m.type === "snapshot").length).toBeGreaterThan(2);
  });
});

describe("session logs (/api/sessions)", () => {
  it("appends NDJSON batches per session and refuses unsafe ids and bad lines", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "penumbra-sessions-"));
    const compiled = compileScenario(def);
    server = new PenumbraServer({ compiled, port: 0, tickMs: 0, snapshotHz: 0, autoplay: false, sessionsDir: dir });
    const { url } = await server.start();
    const base = url.replace("ws://", "http://").replace("/ws", "");
    const post = (id: string, body: string) => fetch(`${base}/api/sessions/${id}`, { method: "POST", body });
    expect((await post("S1", '{"kind":"a"}\n{"kind":"b"}\n')).status).toBe(200);
    expect((await post("S1", '{"kind":"c"}\n')).status).toBe(200);
    expect(readFileSync(join(dir, "S1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind)).toEqual(["a", "b", "c"]);
    expect((await post("..%2Fescape", '{"kind":"x"}')).status).toBe(400);
    expect((await post("S2", "not json")).status).toBe(400);
    expect((await post("S2", "[1,2]")).status).toBe(400);
    expect(await (await fetch(`${base}/api/sessions`)).json()).toEqual([{ id: "S1", bytes: expect.any(Number) }]);
    expect((await fetch(`${base}/api/sessions/S1`)).status).toBe(200);
    expect((await fetch(`${base}/api/sessions/nope`)).status).toBe(404);
  });

  it("is off unless a sessions directory is configured", async () => {
    server = new PenumbraServer({ compiled: compileScenario(def), port: 0, tickMs: 0, snapshotHz: 0, autoplay: false });
    const { url } = await server.start();
    expect((await fetch(`${url.replace("ws://", "http://").replace("/ws", "")}/api/sessions/S1`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("probe report", () => {
  it("aggregates accuracy and median time per view and question, last answer per trial", async () => {
    const { probeReport, formatReport } = await import("../src/probe-report");
    const a = (participant: string, view: string, question: string, correct: boolean, latencyMs: number) => ({
      kind: "probe_answer",
      data: { participant, view, question, correct, latencyMs, trial: `${view}-${question}` },
    });
    const r = probeReport([
      a("P1", "penumbra", "stale", true, 2000),
      a("P1", "legacy", "stale", false, 7000),
      a("P2", "penumbra", "stale", true, 3000),
      a("P2", "legacy", "stale", false, 9000),
      a("P2", "legacy", "stale", true, 5000), // retry: replaces the previous answer
      { kind: "select", data: {} },
    ]);
    expect(r.participants).toBe(2);
    expect(r.answers).toBe(4);
    expect(r.byView.penumbra).toEqual({ n: 2, accuracy: 1, medianMs: 2500 });
    expect(r.byView.legacy).toEqual({ n: 2, accuracy: 0.5, medianMs: 6000 });
    expect(formatReport(r)).toContain("| PENUMBRA | 2 | 100 % | 2.5 s |");
    expect(formatReport(r)).not.toContain("| Scenario |");
  });

  it("keeps the same participant's BER and KMRB answers apart and compares the scenarios", async () => {
    const { probeReport, formatReport } = await import("../src/probe-report");
    const a = (scenario: string | undefined, view: string, correct: boolean, latencyMs: number) => ({
      kind: "probe_answer",
      data: { participant: "P1", ...(scenario ? { scenario } : {}), view, question: "blind", correct, latencyMs, trial: `${view}-blind` },
    });
    const r = probeReport([a(undefined, "legacy", false, 8000), a("mrb-lowcost-approach", "legacy", true, 4000), a("mrb-lowcost-approach", "penumbra", true, 2000)]);
    expect(r.answers).toBe(3);
    expect(r.byScenario["ber-south-uas-surge"]!.legacy).toEqual({ n: 1, accuracy: 0, medianMs: 8000 });
    expect(r.byScenario["mrb-lowcost-approach"]!.penumbra).toEqual({ n: 1, accuracy: 1, medianMs: 2000 });
    expect(formatReport(r)).toContain("| mrb-lowcost-approach | 100 % · 2.0 s | 100 % · 4.0 s |");
  });
});
