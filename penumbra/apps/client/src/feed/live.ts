import type { OperatorActionRequest } from "@penumbra/core";
import type { ServerMsg } from "@penumbra/sim/browser";
import type { FeedSource, FeedStore } from "./store";

/** Live, server-authoritative feed over WebSocket. Resolves false if the server cannot be reached. */
export function connectLive(store: FeedStore, url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let opened = false;
    let nextRequest = 0;
    const pending = new Map<string, (error: string | undefined) => void>();
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (!opened) {
        ws.close();
        resolve(false);
      }
    }, timeoutMs);
    const source: FeedSource = {
      kind: "live",
      control: (command, speed) => ws.send(JSON.stringify({ type: "control", command, ...(speed !== undefined ? { speed } : {}) })),
      act: (req: OperatorActionRequest) =>
        new Promise((done) => {
          const requestId = `act-${++nextRequest}`;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            done("the feed server did not answer");
          }, 5000);
          pending.set(requestId, (err) => {
            clearTimeout(timer);
            done(err);
          });
          ws.send(JSON.stringify({ type: "operator_action", requestId, ...req }));
        }),
      close: () => ws.close(),
    };
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      store.source = source;
      store.setStatus("live");
      resolve(true);
    };
    ws.onerror = () => {
      if (!opened) {
        clearTimeout(timer);
        resolve(false);
      }
    };
    ws.onclose = () => {
      if (opened) store.setStatus("disconnected");
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      switch (msg.type) {
        case "hello":
          store.onHello(msg.meta, msg.clock);
          break;
        case "events":
          store.onEvents(msg.events, msg.reset === true);
          break;
        case "clock":
          store.onClock(msg.clock);
          break;
        case "ack":
          if (msg.requestId) {
            pending.get(msg.requestId)?.(undefined);
            pending.delete(msg.requestId);
          }
          break;
        case "error":
          if (msg.requestId && pending.has(msg.requestId)) {
            pending.get(msg.requestId)!(msg.message);
            pending.delete(msg.requestId);
          } else console.warn("[penumbra feed]", msg.message);
          break;
        default:
          break; // snapshots are computed locally
      }
    };
  });
}
