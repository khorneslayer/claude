import type { LogEvent, Millis, PictureSnapshot } from "@penumbra/core";
import type { ScenarioMeta } from "@penumbra/sim";

/** Bumped on any breaking change to the messages below. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- server -> client

export interface HelloMsg {
  type: "hello";
  protocol: number;
  meta: ScenarioMeta;
  clock: ClockState;
  lastSeq: number;
}

export interface ClockState {
  /** Live head of the feed (simulation time). */
  head: Millis;
  playing: boolean;
  speed: number;
  /** True once head has reached meta.end. */
  ended: boolean;
}

/** New log events, in seq order. Clients keep their own copy for local scrubbing. */
export interface EventsMsg {
  type: "events";
  events: LogEvent[];
  /** True when this batch replaces the client's log (on connect and after restart). */
  reset?: boolean;
}

export interface SnapshotMsg {
  type: "snapshot";
  /** "live" follows the head; otherwise a fixed time the client scrubbed to. */
  view: "live" | Millis;
  snapshot: PictureSnapshot;
}

export interface ClockMsg {
  type: "clock";
  clock: ClockState;
}

export interface AckMsg {
  type: "ack";
  requestId?: string;
  seq?: number;
}

export interface ErrorMsg {
  type: "error";
  requestId?: string;
  message: string;
}

export type ServerMsg = HelloMsg | EventsMsg | SnapshotMsg | ClockMsg | AckMsg | ErrorMsg;

// ---------------------------------------------------------------- client -> server

export interface ControlMsg {
  type: "control";
  requestId?: string;
  command: "play" | "pause" | "restart" | "speed";
  speed?: number;
}

/** Follow the live head, or freeze the view at a past moment. */
export interface ViewMsg {
  type: "view";
  requestId?: string;
  t: "live" | Millis;
}

export interface OperatorActionMsg {
  type: "operator_action";
  requestId?: string;
  operatorId: string;
  action: "resolve" | "defer";
  entityId: string;
  dimension: string;
  value?: string;
}

/** Ask for every event after `fromSeq` (e.g. after a reconnect). */
export interface SyncMsg {
  type: "sync";
  requestId?: string;
  fromSeq: number;
}

export type ClientMsg = ControlMsg | ViewMsg | OperatorActionMsg | SyncMsg;
