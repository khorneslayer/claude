import { formatClock, formatElapsed, type Millis } from "@penumbra/core";
import { useRef } from "react";
import type { TimelineMark } from "../model/timeline";

export type TimelineWindow = "5m" | "15m" | "all";
const WINDOW_MS: Record<TimelineWindow, number> = { "5m": 5 * 60_000, "15m": 15 * 60_000, all: Number.POSITIVE_INFINITY };

/**
 * Two lanes, so marks that would land on top of each other stay clickable:
 * a mark closer than `minGap` (fraction of the span) to the last mark in the
 * upper lane drops to the lower lane.
 */
export function laneMarks(marks: TimelineMark[], from: Millis, to: Millis, minGap = 0.015): (TimelineMark & { lane: 0 | 1; at: number })[] {
  const span = Math.max(1, to - from);
  const last: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return marks
    .filter((m) => m.t >= from && m.t <= to)
    .map((m) => {
      const at = (m.t - from) / span;
      const lane: 0 | 1 = at - last[0] >= minGap ? 0 : at - last[1] >= minGap ? 1 : 0;
      last[lane] = at;
      return { ...m, lane, at };
    });
}

export function timelineRange(logStart: Millis, head: Millis, w: TimelineWindow): { from: Millis; to: Millis } {
  return { from: Math.max(logStart, head - WINDOW_MS[w]), to: head };
}

/**
 * Replay timeline. Drag anywhere to see the picture exactly as it stood at
 * that moment; marks jump to the moments that matter. The live head is the
 * right edge.
 */
export function Timeline(props: {
  logStart: Millis;
  head: Millis;
  t: Millis;
  replaying: boolean;
  marks: TimelineMark[];
  window: TimelineWindow;
  onWindow: (w: TimelineWindow) => void;
  onScrub: (t: Millis) => void;
  onLive: () => void;
}) {
  const { logStart, head, t, replaying, marks, window: w, onWindow, onScrub, onLive } = props;
  const track = useRef<HTMLDivElement>(null);
  const { from, to } = timelineRange(logStart, head, w);
  const span = Math.max(1, to - from);
  const x = (time: Millis) => `${(Math.min(1, Math.max(0, (time - from) / span)) * 100).toFixed(3)}%`;
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return from + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const scrub = (clientX: number) => {
    const at = timeAt(clientX);
    if (to - at < span * 0.004) onLive();
    else onScrub(Math.round(at));
  };
  return (
    <div className={`timeline${replaying ? " replaying" : ""}`}>
      <div className="tl-controls">
        {(["5m", "15m", "all"] as TimelineWindow[]).map((k) => (
          <button key={k} className={k === w ? "on" : ""} onClick={() => onWindow(k)} title="Timeline window">
            {k.toUpperCase()}
          </button>
        ))}
      </div>
      <div
        className="tl-track"
        ref={track}
        role="slider"
        aria-label="Replay time"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={t}
        aria-valuetext={formatClock(t)}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          scrub(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) scrub(e.clientX);
        }}
      >
        <div className="tl-past" style={{ width: x(t) }} />
        {laneMarks(marks, from, to).map((m, i) => (
            <button
              key={`${m.t}-${i}`}
              className={`tl-mark ${m.kind} lane-${m.lane}`}
              style={{ left: x(m.t) }}
              title={`${formatClock(m.t)} · ${m.label}`}
              aria-label={`${formatClock(m.t)} ${m.label}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onScrub(m.t)}
            />
          ))}
        <div className="tl-head" style={{ left: x(t) }} />
        <span className="tl-time start">{formatClock(from)}</span>
        <span className="tl-time end">{formatClock(to)}</span>
      </div>
      <button className={`tl-live${replaying ? "" : " on"}`} onClick={onLive} title="Back to live (End)">
        {replaying ? `LIVE ▸ −${formatElapsed((head - t) / 1000)}` : "● LIVE"}
      </button>
    </div>
  );
}

export function ReplayBanner({ t, head, onLive }: { t: Millis; head: Millis; onLive: () => void }) {
  return (
    <div className="replay-banner" role="status">
      <b>REPLAY {formatClock(t)}</b>
      <span>{formatElapsed((head - t) / 1000)} behind live · as it stood then</span>
      <button onClick={onLive}>Back to live</button>
    </div>
  );
}
