import { formatClock, type FeedHealth } from "@penumbra/core";
import type { FeedStatus, FeedStore } from "../feed/store";

const NAMES: Partial<Record<FeedHealth["sourceType"], string>> = { ADSB: "ADS-B", RF: "RF SENSE", EO: "EO", CIV_CALL: "CIV REPORTS" };
const ORDER = ["ADSB", "RF", "EO", "CIV_CALL"];

export function feedChips(health: FeedHealth[]) {
  return ORDER.flatMap((type) => {
    const h = health.find((x) => x.sourceType === type);
    if (!h) return [];
    const name = NAMES[h.sourceType]!;
    const text = h.status === "ok" ? `${name} OK` : h.total > 1 ? `${name} ${h.up}/${h.total}` : `${name} ${h.status.toUpperCase()}`;
    // A whole report channel degraded is worse news than one sensor of six.
    const tone = h.status === "ok" ? "ok" : h.status === "down" || h.total === 1 ? "down" : "degraded";
    return [{ key: type, text, tone }];
  });
}

const SPEEDS = [0.5, 1, 2, 4, 8, 16];

export function Header(props: {
  store: FeedStore;
  status: FeedStatus;
  operator: string;
  t?: number;
  health: FeedHealth[];
  frozen: boolean;
  replay: boolean;
  /** Probe / demo: the view is set by the script, not the operator. */
  locked?: boolean;
  view: "penumbra" | "legacy";
  onView: (v: "penumbra" | "legacy") => void;
}) {
  const { store, status, operator, t, health, frozen, replay, view, onView, locked = false } = props;
  const clock = store.clock;
  return (
    <header className="header">
      <div className="wordmark">PENUMBRA</div>
      <div className="scenario">{store.meta?.title ?? "connecting…"}</div>
      <div className="chips">
        {feedChips(health).map((c) => (
          <span key={c.key} className={`chip ${c.tone}`}>
            {c.text}
          </span>
        ))}
      </div>
      {!locked && <div className="viewswitch" role="group" aria-label="View (V)">
        <button className={view === "penumbra" ? "on" : ""} onClick={() => onView("penumbra")} aria-pressed={view === "penumbra"}>
          PENUMBRA
        </button>
        <button className={view === "legacy" ? "on legacy" : ""} onClick={() => onView("legacy")} aria-pressed={view === "legacy"}>
          LEGACY
        </button>
      </div>}
      {locked && <div className={`viewswitch locked`} aria-label="View">{view === "legacy" ? <button className="on legacy">LEGACY</button> : <button className="on">PENUMBRA</button>}</div>}
      <div className="operator" title="Operator id for RESOLVE / DEFER (?op=)">{operator}</div>
      <div className={`clock${replay ? " replay" : ""}`}>
        {replay && <span className="tag">REPLAY</span>}
        {t !== undefined ? formatClock(t) : "--:--:--Z"}
      </div>
      {!frozen && (
        <div className="transport">
          <span className={`mode ${status === "live" ? "live" : ""}`}>{status === "live" ? "LIVE FEED" : status.toUpperCase()}</span>
          <button onClick={() => store.control(clock?.playing ? "pause" : "play")} title="Play / pause (space)">
            {clock?.playing ? "❚❚" : "▶"}
          </button>
          <select value={clock?.speed ?? 1} onChange={(e) => store.control("speed", Number(e.target.value))} title="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <button onClick={() => store.control("restart")} title="Restart scenario">
            ⟲
          </button>
        </div>
      )}
    </header>
  );
}
