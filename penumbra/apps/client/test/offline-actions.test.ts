import { describe, expect, it } from "vitest";
import { startOffline } from "../src/feed/offline";
import { FeedStore } from "../src/feed/store";

describe("offline feed: operator actions", () => {
  it("is interactive by default: playback decisions are left to the operator", async () => {
    const store = new FeedStore();
    const src = startOffline(store, { at: "14:41:45", paused: true });
    try {
      const snap = store.evaluate(store.headNow()!);
      expect(snap.contradictions.find((c) => c.id === "CTR-004")!.status).toBe("unresolved"); // scripted 14:41:40 resolve dropped
      expect(snap.contradictions.find((c) => c.id === "CTR-003")!.status).toBe("deferred"); // history kept
    } finally {
      src.close();
    }
  });

  it("appends a valid action at the head and rejects an invalid one", async () => {
    const store = new FeedStore();
    const src = startOffline(store, { at: "14:41:22", paused: true });
    try {
      const head = store.headNow()!;
      const seqBefore = store.log.at(-1)!.seq;
      expect(await store.act({ operatorId: "OP-7", action: "resolve", entityId: "TRK-1155", dimension: "intent", value: "flying-saucer" })).toMatch(/must be one of/);
      expect(await store.act({ operatorId: "OP-7", action: "resolve", entityId: "TRK-1155", dimension: "intent", value: "hobbyist" })).toBeUndefined();
      const last = store.log.at(-1)!;
      expect(last).toMatchObject({ kind: "operator_action", t: head, seq: seqBefore + 1, operatorId: "OP-7", value: "hobbyist" });
      const snap = store.evaluate(head);
      const c = snap.contradictions.find((x) => x.id === "CTR-004")!;
      expect([c.status, c.actedBy]).toEqual(["resolved", "OP-7"]);
      expect(await store.act({ operatorId: "OP-7", action: "defer", entityId: "TRK-1155", dimension: "intent" })).toMatch(/already resolved/);
    } finally {
      src.close();
    }
  });

  it("keeps sequence numbers increasing after an action when playback continues", async () => {
    const store = new FeedStore();
    const src = startOffline(store, { at: "14:41:22", paused: true });
    try {
      await store.act({ operatorId: "OP-1", action: "defer", entityId: "TRK-1155", dimension: "intent" });
      src.control("speed", 16);
      src.control("play");
      await new Promise((r) => setTimeout(r, 400));
      const seqs = store.log.map((e) => e.seq);
      expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!)).toBe(true);
      expect(store.log.at(-1)!.t).toBeGreaterThan(store.log.find((e) => e.kind === "operator_action" && e.operatorId === "OP-1")!.t);
    } finally {
      src.close();
    }
  });
});
