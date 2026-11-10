import ms from "milsymbol";
import { type RGB } from "../theme";

export interface IconDef {
  id: string;
  url: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  mask: false;
}

const cache = new Map<string, IconDef>();

/**
 * APP-6 / 2525 symbol as a monochrome outline in the category colour. PENUMBRA
 * modulates standard symbology (ring, opacity, frame dash); it does not replace it.
 */
export function symbolIcon(sidc: string, color: RGB): IconDef {
  const hex = `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const id = `${sidc}:${hex}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const sym = new ms.Symbol(sidc, { size: 22, monoColor: hex, fill: false, strokeWidth: 3, outlineWidth: 0 });
  const svg = sym.asSVG();
  const size = sym.getSize();
  const anchor = sym.getAnchor();
  const def: IconDef = {
    id,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: Math.ceil(size.width),
    height: Math.ceil(size.height),
    anchorX: anchor.x,
    anchorY: anchor.y,
    mask: false,
  };
  cache.set(id, def);
  return def;
}

/** Hollow diamond for a competing hypothesis (slide 7 CAND-A / CAND-B). */
export function diamondIcon(color: RGB): IconDef {
  const hex = `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const id = `diamond:${hex}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect x="9" y="9" width="18" height="18" transform="rotate(45 18 18)" fill="#0b1020" fill-opacity="0.85" stroke="${hex}" stroke-width="3"/></svg>`;
  const def: IconDef = { id, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: 36, height: 36, anchorX: 18, anchorY: 18, mask: false };
  cache.set(id, def);
  return def;
}
