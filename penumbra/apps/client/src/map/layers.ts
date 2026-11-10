import type { Layer } from "@deck.gl/core";
import { FillStyleExtension, PathStyleExtension, type FillStyleExtensionProps, type PathStyleExtensionProps } from "@deck.gl/extensions";
import { IconLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { Coverage, CoverageFootprint } from "@penumbra/core";
import type { Bounds } from "../model/coverage";
import type { Placement } from "../model/place";
import type { Envelope, FlagMarker, Glyph, Link, LonLat, RenderModel, Wedge } from "../model/view";
import { C, rgba, type RGB } from "../theme";
import { AREAS, grid, LABELS, RUNWAYS, TAXIWAY_WIDTH_M, TAXIWAYS, type Area } from "./basemap";
import { ConfidenceRingLayer } from "./ConfidenceRingLayer";
import { HATCH_MAPPING, hatchAtlas } from "./hatch";
import { diamondIcon, symbolIcon } from "./symbols";

const FONT = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const dashed = new PathStyleExtension({ dash: true });
const patterned = new FillStyleExtension({ pattern: true });

const text = {
  fontFamily: FONT,
  characterSet: "auto" as const,
  fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
  outlineWidth: 4,
  outlineColor: rgba(C.bg, 230),
};

/** Ghosts fade with the age of their last fix, but never below legibility. */
const glyphAlpha = (g: Glyph) => (g.kind === "ghost" ? 150 : 90 + 165 * g.confidence);

export interface LayerInputs {
  model: RenderModel;
  bounds: Bounds;
  coverage?: { coverage: Coverage; label?: { position: LonLat; lines: string[] } };
  placement?: Map<string, Placement | null>;
  hoveredId?: string;
  zoom?: number;
}

const DEFAULT_PLACEMENT: Placement = { anchor: "start", line1: [26, -1], line2: [26, 1] };

const rings = (f: CoverageFootprint): LonLat[][] => [f.footprint.outer, ...(f.footprint.holes ?? [])].map((r) => r.map((p) => [p.lon, p.lat] as LonLat));

/**
 * Coverage, exact at any zoom, painted back to front:
 *   faint hatch everywhere ("no sensor has ever covered this")
 *   strong hatch over footprints of sensors that are down ("we used to see here")
 *   degraded footprints: background plus an amber tint
 *   live footprints: solid background, erasing the hatch ("covered: empty means empty")
 * The basemap and the picture draw on top.
 */
function coverageLayers(cov: Coverage, bounds: Bounds, zoom: number): Layer[] {
  // Fill patterns are sized in metres; keep the hatch about 20 px on screen at any zoom.
  const midLat = (bounds.north + bounds.south) / 2;
  const metresPerPixel = (78271.5 * Math.cos((midLat * Math.PI) / 180)) / 2 ** zoom;
  const patternScale = (20 * metresPerPixel) / 32;
  const uas = (f: CoverageFootprint) => f.layers.includes("uas");
  const all: LonLat[][] = [
    [
      [bounds.west, bounds.north],
      [bounds.east, bounds.north],
      [bounds.east, bounds.south],
      [bounds.west, bounds.south],
      [bounds.west, bounds.north],
    ],
  ];
  const hatch = (id: string, data: LonLat[][][], color: RGB, alpha: number) =>
    new PolygonLayer<LonLat[][], FillStyleExtensionProps<LonLat[][]>>({
      id,
      data,
      getPolygon: (d) => d,
      getFillColor: rgba(color, alpha),
      stroked: false,
      fillPatternAtlas: hatchAtlas(),
      fillPatternMapping: HATCH_MAPPING,
      fillPatternMask: true,
      getFillPattern: () => "hatch",
      getFillPatternScale: patternScale,
      updateTriggers: { getFillPatternScale: patternScale },
      extensions: [patterned],
    });
  const solid = (id: string, data: CoverageFootprint[], color: RGB, alpha = 255) =>
    new PolygonLayer<CoverageFootprint>({ id, data, getPolygon: rings, getFillColor: rgba(color, alpha), stroked: false });
  return [
    hatch("cov-blind", [all], C.blind, 60),
    hatch("cov-lost", cov.lost.filter(uas).map(rings), C.blind, 190),
    solid("cov-degraded-erase", cov.active.filter((f) => uas(f) && f.status === "degraded"), C.bg),
    hatch("cov-degraded", cov.active.filter((f) => uas(f) && f.status === "degraded").map(rings), C.amber, 26),
    solid("cov-live", cov.active.filter((f) => uas(f) && f.status === "up"), C.bg),
  ];
}

/** Coverage plus its label. Rebuild only when the coverage key or zoom bucket changes. */
export function buildCoverageLayers(cov: Coverage, bounds: Bounds, zoom: number, label?: { position: LonLat; lines: string[] }): Layer[] {
  const layers = coverageLayers(cov, bounds, Math.round(zoom * 4) / 4);
  if (label) {
    layers.push(
      new TextLayer({
        id: "coverage-label",
        data: [label],
        getText: (d) => d.lines.join("\n"),
        getPosition: (d) => d.position,
        getColor: rgba(C.text, 210),
        getSize: 13,
        lineHeight: 1.4,
        ...text,
      }),
    );
  }
  return layers;
}

/** EDDB basemap traced from the R. Aehnelt chart. Build once per bounds. */
/** Zoom at which each class of basemap label appears, so the picture is never buried in chart text. */
const LABEL_MIN_ZOOM = { major: 0, runway: 12.5, minor: 14.2, taxiway: 14.8 } as const;

export function buildStaticLayers(bounds: Bounds, zoom = 13): Layer[] {
  const fill = (a: Area) =>
    a.kind === "apron" ? rgba(C.apron, 255) : a.kind === "terminal" ? rgba(C.building, 230) : a.kind === "building" ? rgba(C.building, 170) : rgba(C.apron, 0);
  const ends = RUNWAYS.flatMap((r) => r.ends);
  return [
    new PathLayer<LonLat[]>({
      id: "grid",
      data: grid(bounds),
      getPath: (d) => d,
      getColor: rgba(C.grid, 70),
      widthUnits: "pixels",
      getWidth: 1,
    }),
    new PolygonLayer<Area>({
      id: "aprons",
      data: AREAS.filter((a) => a.kind === "apron"),
      getPolygon: (d) => d.polygon,
      getFillColor: fill,
      getLineColor: rgba(C.taxiway, 255),
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      stroked: true,
    }),
    new PathLayer({
      id: "taxiways",
      data: TAXIWAYS,
      getPath: (d) => d.path,
      getColor: rgba(C.taxiway, 255),
      widthUnits: "meters",
      getWidth: TAXIWAY_WIDTH_M,
      widthMinPixels: 1.5,
      jointRounded: true,
      capRounded: true,
    }),
    new PathLayer({
      id: "runways",
      data: RUNWAYS,
      getPath: (d) => d.path,
      getColor: rgba(C.runway, 255),
      widthUnits: "meters",
      getWidth: (d) => d.widthM,
      widthMinPixels: 4,
      capRounded: false,
    }),
    new PathLayer<{ path: LonLat[] }, PathStyleExtensionProps<{ path: LonLat[] }>>({
      id: "runway-centrelines",
      data: RUNWAYS,
      getPath: (d) => d.path,
      getColor: rgba(C.text, 70),
      widthUnits: "pixels",
      getWidth: 1,
      getDashArray: [6, 6],
      extensions: [dashed],
    }),
    new PolygonLayer<Area>({
      id: "buildings",
      data: AREAS.filter((a) => a.kind !== "apron"),
      getPolygon: (d) => d.polygon,
      getFillColor: fill,
      getLineColor: (d) => (d.kind === "outline" ? rgba(C.dim, 150) : rgba(C.building, 255)),
      getLineWidth: 1,
      lineWidthUnits: "pixels",
      stroked: true,
    }),
    new PathLayer<Area, PathStyleExtensionProps<Area>>({
      id: "expocenter-outline",
      data: AREAS.filter((a) => a.kind === "outline"),
      getPath: (d) => d.polygon,
      getColor: rgba(C.dim, 170),
      widthUnits: "pixels",
      getWidth: 1.2,
      getDashArray: [5, 4],
      extensions: [dashed],
    }),
    new TextLayer({
      id: "runway-designators",
      data: ends,
      getText: (d) => `${d.designator}\n${d.heading}`,
      getPosition: (d) => d.outward,
      getColor: rgba(C.text, 220),
      getSize: 13,
      lineHeight: 1.2,
      background: true,
      getBackgroundColor: rgba(C.bg, 230),
      getBorderColor: rgba(C.runway, 255),
      getBorderWidth: 1,
      backgroundPadding: [5, 3, 5, 3],
      ...text,
      outlineWidth: 0,
    }),
    new TextLayer({
      id: "basemap-labels",
      data: LABELS.filter((l) => zoom >= LABEL_MIN_ZOOM[l.kind]),
      getText: (d) => d.text,
      getPosition: (d) => d.position,
      getAngle: (d) => d.angle ?? 0,
      getColor: (d) => (d.kind === "major" ? rgba(C.dim, 230) : d.kind === "runway" ? rgba(C.runway, 255) : d.kind === "taxiway" ? rgba(C.runway, 200) : rgba(C.runway, 230)),
      getSize: (d) => (d.kind === "major" ? 12 : d.kind === "taxiway" ? 10 : 11),
      getPixelOffset: (d) => (d.kind === "runway" ? [0, -10] : [0, 0]),
      ...text,
      outlineWidth: 2,
    }),
  ];
}

/** The picture itself: rebuilt every evaluation tick. */
export function buildDynamicLayers({ model, placement, hoveredId, selectedId }: Pick<LayerInputs, "model" | "placement" | "hoveredId"> & { selectedId?: string }): Layer[] {
  const layers: Layer[] = [];
  const place = (id: string) => placement?.get(id) ?? DEFAULT_PLACEMENT;
  const placeKey = placement ? [...placement].map(([k, v]) => (v ? `${k}:${v.anchor}${v.line1.join(",")}` : `${k}:-`)).join("|") : "";

  // --- uncertainty: ghost envelopes, bearing wedges -------------------------
  layers.push(
    new PolygonLayer<Wedge>({
      id: "bearing-wedges",
      data: model.wedges,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => rgba(d.color, 12),
      getLineColor: (d) => rgba(d.color, 55),
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      stroked: true,
    }),
    new PolygonLayer<Envelope>({
      id: "envelope-fill",
      data: model.envelopes.filter((e) => e.kind === "plausible"),
      getPolygon: (d) => d.path,
      getFillColor: rgba(C.grey, 16),
      stroked: false,
    }),
    new PathLayer<Envelope, PathStyleExtensionProps<Envelope>>({
      id: "envelopes",
      data: model.envelopes,
      getPath: (d) => d.path,
      getColor: (d) => (d.kind === "plausible" ? rgba(C.grey, 190) : rgba(C.grey, 45)),
      widthUnits: "pixels",
      getWidth: (d) => (d.kind === "plausible" ? 1.5 : 1),
      getDashArray: (d) => (d.kind === "plausible" ? [6, 5] : [2, 6]),
      extensions: [dashed],
    }),
  );

  // --- contradiction links, deception spokes -------------------------------
  const spokes = model.flags.flatMap((f) => f.spokes);
  layers.push(
    new PathLayer<Link, PathStyleExtensionProps<Link>>({
      id: "links",
      data: [...model.links, ...spokes],
      getPath: (d) => d.path,
      getColor: (d) => rgba(d.color, model.links.includes(d) ? 230 : 110),
      widthUnits: "pixels",
      getWidth: (d) => (model.links.includes(d) ? 2 : 1),
      getDashArray: [5, 5],
      extensions: [dashed],
    }),
    new ScatterplotLayer<LonLat>({
      id: "flag-reports",
      data: model.flags.flatMap((f) => f.reports),
      getPosition: (d) => d,
      getFillColor: rgba(C.orange, 200),
      radiusUnits: "pixels",
      getRadius: 2.5,
    }),
  );

  // --- entities: confidence rings, symbols, candidate diamonds -------------
  const glyphs = model.glyphs;
  const selected = glyphs.filter((g) => g.id === selectedId);
  layers.push(
    new ScatterplotLayer<Glyph>({
      id: "selection",
      data: selected,
      getPosition: (d) => d.position,
      filled: false,
      stroked: true,
      getLineColor: rgba(C.text, 230),
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
      radiusUnits: "pixels",
      getRadius: 33,
    }),
  );
  const tracks = glyphs.filter((g) => g.kind !== "candidate");
  const candidates = glyphs.filter((g) => g.kind === "candidate");
  layers.push(
    new ConfidenceRingLayer<Glyph>({
      id: "confidence-rings",
      data: glyphs,
      getPosition: (d) => d.position,
      getFillColor: (d) => rgba(d.color, d.kind === "ghost" ? 120 : 255),
      getConfidence: (d) => d.confidence,
      getRings: (d) => d.rings,
      radiusUnits: "pixels",
      getRadius: (d) => (d.id === hoveredId ? 30 : 24),
      pickable: true,
      updateTriggers: { getRadius: hoveredId },
    }),
    new IconLayer<Glyph>({
      id: "symbols",
      data: tracks,
      getPosition: (d) => d.position,
      getIcon: (d) => symbolIcon(d.sidc, d.color),
      getSize: 26,
      sizeUnits: "pixels",
      getColor: (d) => [255, 255, 255, glyphAlpha(d)],
      pickable: true,
    }),
    new IconLayer<Glyph>({
      id: "candidate-diamonds",
      data: candidates,
      getPosition: (d) => d.position,
      getIcon: (d) => diamondIcon(d.color),
      getSize: 30,
      sizeUnits: "pixels",
      getColor: (d) => [255, 255, 255, glyphAlpha(d)],
      pickable: true,
    }),
  );

  // --- labels ----------------------------------------------------------------
  // Hidden (null) placements come back on hover.
  const labelled = glyphs.filter((g) => (g.category !== "cooperative" && placement?.get(g.id) !== null) || g.entityId === hoveredId);
  layers.push(
    new TextLayer<Glyph>({
      id: "labels-1",
      data: labelled,
      getText: (d) => d.label[0]!,
      getPosition: (d) => d.position,
      getColor: (d) => (d.kind === "ghost" ? rgba(C.text, 200) : rgba(C.text, 255)),
      getSize: 13,
      getTextAnchor: (d) => place(d.id).anchor,
      getAlignmentBaseline: "bottom",
      getPixelOffset: (d) => place(d.id).line1,
      updateTriggers: { getTextAnchor: placeKey, getPixelOffset: placeKey },
      ...text,
    }),
    new TextLayer<Glyph>({
      id: "labels-2",
      data: labelled,
      getText: (d) => d.label[1] ?? "",
      getPosition: (d) => d.position,
      getColor: (d) => rgba(d.accent, d.kind === "ghost" ? 190 : 255),
      getSize: 13,
      getTextAnchor: (d) => place(d.id).anchor,
      getAlignmentBaseline: "top",
      getPixelOffset: (d) => place(d.id).line2,
      updateTriggers: { getTextAnchor: placeKey, getPixelOffset: placeKey },
      ...text,
    }),
    // Civil traffic: callsign only, small, so it reads as context.
    new TextLayer<Glyph>({
      id: "labels-civil",
      data: glyphs.filter((g) => g.category === "cooperative" && g.id !== hoveredId),
      getText: (d) => d.label[0]!,
      getPosition: (d) => d.position,
      getColor: rgba(C.neutral, 200),
      getSize: 11,
      getTextAnchor: "start",
      getAlignmentBaseline: "center",
      getPixelOffset: [18, 0],
      ...text,
    }),
  );

  // --- deception flags (on top) ---------------------------------------------
  layers.push(
    new ScatterplotLayer<FlagMarker>({
      id: "flag-marker",
      data: model.flags,
      getPosition: (d) => d.position,
      getFillColor: rgba(C.orange, 40),
      getLineColor: rgba(C.orange, 255),
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      radiusUnits: "pixels",
      getRadius: 14,
      pickable: true,
    }),
    new TextLayer<FlagMarker>({
      id: "flag-labels",
      data: model.flags,
      getText: (d) => d.label.join("\n"),
      getPosition: (d) => d.position,
      getColor: rgba(C.orange, 255),
      getSize: 13,
      lineHeight: 1.35,
      getTextAnchor: "middle",
      getAlignmentBaseline: "bottom",
      getPixelOffset: [0, -34],
      background: true,
      getBackgroundColor: rgba(C.bg, 235),
      getBorderColor: rgba(C.orange, 255),
      getBorderWidth: 1,
      backgroundPadding: [8, 6, 8, 6],
      ...text,
      outlineWidth: 0,
    }),
  );

  return layers;
}

export function colorOf(c: RGB, a = 1): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}
