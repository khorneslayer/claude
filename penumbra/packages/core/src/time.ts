import type { Millis } from "./types";

/** "14:41:22" on 2026-09-12 -> epoch ms (UTC). Accepts "HH:MM" or "HH:MM:SS(.sss)", optional trailing Z. */
export function clockToMillis(date: string, clock: string): Millis {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?Z?$/.exec(clock.trim());
  if (!m) throw new Error(`Invalid clock time "${clock}" (expected HH:MM:SS)`);
  const iso = `${date}T${m[1]}:${m[2]}:00Z`;
  const base = Date.parse(iso);
  if (Number.isNaN(base)) throw new Error(`Invalid date "${date}"`);
  return base + Math.round(Number(m[3] ?? 0) * 1000);
}

/** epoch ms -> "14:41:22Z" */
export function formatClock(t: Millis): string {
  return new Date(t).toISOString().slice(11, 19) + "Z";
}

/** seconds -> "04:12" (mm:ss), or "1:02:03" past an hour. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
