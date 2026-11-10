/** Palette from the slide 7 target screen. RGB triples for deck.gl; CSS variables mirror these in styles.css. */
export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export const C = {
  bg: [8, 12, 26] as RGB,
  grid: [36, 44, 78] as RGB,
  runway: [58, 66, 140] as RGB,
  terrain: [22, 28, 52] as RGB,
  text: [223, 230, 243] as RGB,
  dim: [138, 147, 168] as RGB,
  cyan: [63, 224, 245] as RGB, // corroborated
  orange: [242, 107, 58] as RGB, // contradicted / low reliability
  amber: [242, 179, 58] as RGB, // degraded
  grey: [150, 158, 178] as RGB, // aged / ghost
  neutral: [150, 214, 176] as RGB, // cooperative civil traffic
  blind: [120, 128, 170] as RGB, // no coverage
};

export const rgba = (c: RGB, a = 255): RGBA => [c[0], c[1], c[2], Math.round(a)];
export const css = (c: RGB, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
