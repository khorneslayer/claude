import type { ServerMsg } from "@penumbra/sim/browser";
import type { FeedSource, FeedStore } from "./store";

/** Live, server-authoritative feed over WebSocket. Resolves false if the server cannot be reached. */
export function connectLive(store: FeedStore, url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let opened = false;
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
        case "error":
          console.warn("[penumbra feed]", msg.message);
          break;
        default:
          break; // snapshots are computed locally; acks need no handling here
      }
    };
  });
}
