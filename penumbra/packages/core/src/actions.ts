import type { ContradictionView, PictureSnapshot } from "./types";

export interface OperatorActionRequest {
  operatorId: string;
  action: "resolve" | "defer";
  entityId: string;
  dimension: string;
  value?: string;
}

/** Can this action be taken against the picture as it stands? Returns a reason when not. */
export function validateOperatorAction(snapshot: PictureSnapshot, a: OperatorActionRequest): string | undefined {
  if (typeof a.operatorId !== "string" || !a.operatorId) return "operatorId is required";
  if (a.action !== "resolve" && a.action !== "defer") return "action must be resolve or defer";
  if (typeof a.entityId !== "string" || typeof a.dimension !== "string") return "entityId and dimension are required";
  const c = snapshot.contradictions.find((x) => x.entityId === a.entityId && x.dimension === a.dimension);
  if (!c) return `no contradiction on ${a.entityId} ${a.dimension}`;
  if (c.status === "resolved") return `${c.id} is already resolved`;
  if (c.status === "lapsed") return `${c.id} has lapsed: support for all but one value has decayed`;
  if (a.action === "defer" && c.status === "deferred") return `${c.id} is already deferred`;
  if (a.action === "resolve" && !c.hypotheses.some((h) => h.value === a.value && h.status !== "rejected")) {
    return `resolve value must be one of: ${c.hypotheses.map((h) => h.value).join(", ")}`;
  }
  return undefined;
}

/** Contradictions an operator can still act on. */
export function isActionable(c: ContradictionView): boolean {
  return c.status === "unresolved" || c.status === "deferred";
}
