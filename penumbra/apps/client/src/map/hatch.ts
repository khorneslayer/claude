/** 32 px diagonal hatch tile, used as a fill-pattern mask (tinted per layer). */
let atlas: HTMLCanvasElement | undefined;

export function hatchAtlas(): HTMLCanvasElement {
  if (atlas) return atlas;
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#fff";
  g.lineWidth = 3.2;
  for (let k = -32; k <= 64; k += 16) {
    g.beginPath();
    g.moveTo(k, 32);
    g.lineTo(k + 32, 0);
    g.stroke();
  }
  atlas = c;
  return c;
}

export const HATCH_MAPPING = { hatch: { x: 0, y: 0, width: 32, height: 32, mask: true } };
