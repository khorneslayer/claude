import type { DraftEvent, LogEvent, Millis } from "./types";

/**
 * Append-only event log. Sequence numbers are assigned here and nowhere else.
 * Events must arrive in non-decreasing time order: the log never rewrites the past.
 */
export class EventLog {
  private readonly events: LogEvent[] = [];

  constructor(initial: readonly LogEvent[] = []) {
    for (const e of initial) this.push(e);
  }

  get length(): number {
    return this.events.length;
  }

  get lastSeq(): number {
    return this.events[this.events.length - 1]?.seq ?? 0;
  }

  get lastT(): Millis {
    return this.events[this.events.length - 1]?.t ?? Number.NEGATIVE_INFINITY;
  }

  /** Append an event that already carries a seq (e.g. replaying a compiled scenario). */
  push(e: LogEvent): LogEvent {
    if (e.seq <= this.lastSeq) throw new Error(`Log seq must increase: got ${e.seq} after ${this.lastSeq}`);
    if (e.t < this.lastT) throw new Error(`Log time must not go backwards: got ${e.t} after ${this.lastT}`);
    const frozen = Object.freeze(e);
    this.events.push(frozen);
    return frozen;
  }

  /** Append a new event, assigning the next seq. */
  append(draft: DraftEvent): LogEvent {
    return this.push({ ...draft, seq: this.lastSeq + 1 } as LogEvent);
  }

  /** Read-only view of every event. */
  all(): readonly LogEvent[] {
    return this.events;
  }

  /** Events with seq greater than `seq`. */
  since(seq: number): LogEvent[] {
    // seqs are increasing but not necessarily dense; binary search for the first > seq.
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid]!.seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return this.events.slice(lo);
  }
}
