/**
 * Greedy screen-space label placement. A fielded COP's labels pile on top of
 * each other in exactly the dense moments that matter; this keeps them legible.
 * Pure: the caller supplies the projection.
 */
export interface Placement {
  anchor: "start" | "end" | "middle";
  /** Pixel offsets for label line 1 (baseline bottom) and line 2 (baseline top). */
  line1: [number, number];
  line2: [number, number];
}

export interface LabelItem {
  id: string;
  position: [number, number];
  lines: string[];
  /** Higher places first. */
  priority: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const CHAR_W = 7.9; // 13 px monospace
const LINE_H = 17;
const GAP = 26;

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

const CANDIDATES: Placement[] = [
  { anchor: "start", line1: [GAP, -1], line2: [GAP, 1] }, // right
  { anchor: "end", line1: [-GAP, -1], line2: [-GAP, 1] }, // left
  { anchor: "middle", line1: [0, -GAP - LINE_H], line2: [0, -GAP - LINE_H + 2] }, // above
  { anchor: "middle", line1: [0, GAP + 2], line2: [0, GAP + 4 + LINE_H] }, // below
];

function boxFor(p: [number, number], lines: string[], c: Placement): Box {
  const w = Math.max(...lines.map((l) => l.length)) * CHAR_W;
  const h = LINE_H * lines.length;
  const x0 = c.anchor === "start" ? p[0] + c.line1[0] : c.anchor === "end" ? p[0] + c.line1[0] - w : p[0] - w / 2;
  const top = p[1] + c.line1[1] - LINE_H;
  return { x0, y0: top, x1: x0 + w, y1: top + h };
}

/** Labels at or above this priority are always shown, even if they must overlap. */
export const ALWAYS_LABEL = 5;

/**
 * Returns a placement per label, or `null` when a lower-priority label has no
 * free spot: it is hidden and appears on hover, instead of adding to the pile.
 */
export function placeLabels(
  items: LabelItem[],
  project: (p: [number, number]) => [number, number],
  obstacles: { position: [number, number]; radius: number }[] = [],
  extraBoxes: Box[] = [],
  screen?: { width: number; height: number },
): Map<string, Placement | null> {
  const offScreen = (b: Box) => (screen ? b.x0 < 0 || b.y0 < 0 || b.x1 > screen.width || b.y1 > screen.height : false);
  const taken: Box[] = [
    ...extraBoxes,
    ...obstacles.map((o) => {
      const [x, y] = project(o.position);
      return { x0: x - o.radius, y0: y - o.radius, x1: x + o.radius, y1: y + o.radius };
    }),
  ];
  const out = new Map<string, Placement | null>();
  for (const item of [...items].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    const p = project(item.position);
    let chosen = CANDIDATES[0]!;
    let best = Number.POSITIVE_INFINITY;
    for (const c of CANDIDATES) {
      const box = boxFor(p, item.lines, c);
      const hits = taken.filter((t) => overlaps(t, box)).length + (offScreen(box) ? 1 : 0);
      if (hits < best) {
        best = hits;
        chosen = c;
        if (hits === 0) break;
      }
    }
    if (best > 0 && item.priority < ALWAYS_LABEL) {
      out.set(item.id, null);
      continue;
    }
    taken.push(boxFor(p, item.lines, chosen));
    out.set(item.id, chosen);
  }
  return out;
}
