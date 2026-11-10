/**
 * Eastern WV Regional / Shepherd Field (KMRB), Martinsburg WV: airport layout
 * traced from the FBO airport diagram (MRB Aviation, base chart © 2016
 * ForeFlight LLC). The chart image is NOT in the repository; only this
 * hand-traced geometry is. Check the chart licence before any external use.
 * NOT FOR OPERATIONAL USE / NAVIGATION.
 *
 * Georeference fitted to the chart itself (1760 x 1314 image):
 *   scale     runway 08/26 is 8815 ft = 2687 m over 1469 chart px -> 1.830 m/px
 *   rotation  the chart is drawn true-north-up (vertical arrow = true north,
 *             tilted arrow = magnetic, VAR 8 deg W); the runway measures
 *             072 deg true on the chart, matching 079 deg magnetic - 8 deg W
 *   anchor    published ARP N 39 24' 07" W 077 59' 05" at the runway midpoint
 *             (approximate: verify against the current FAA 5010 before use)
 */
import type { LatLon } from "@penumbra/core";
import { georef, rect, type AirportLayout, type Area, type MapLabel, type Px, type Runway } from "./layout";

export const ARP: LatLon = { lat: 39 + 24 / 60 + 7 / 3600, lon: -(77 + 59 / 60 + 5 / 3600) };
const RWY = { w: [175, 805] as Px, e: [1572, 352] as Px };
const ARP_PX: Px = [(RWY.w[0] + RWY.e[0]) / 2, (RWY.w[1] + RWY.e[1]) / 2];
export const METRES_PER_PX = 2687 / Math.hypot(RWY.e[0] - RWY.w[0], RWY.e[1] - RWY.w[1]);
const G = georef(ARP, ARP_PX, METRES_PER_PX, 90);
export const pxToLatLon = G.pxToLatLon;
const { ll, path, ring } = G;

/** Unit vector along the runway (chart px, 08 -> 26). */
const along = (() => {
  const dx = RWY.e[0] - RWY.w[0];
  const dy = RWY.e[1] - RWY.w[1];
  const n = Math.hypot(dx, dy);
  return [dx / n, dy / n] as const;
})();
/** A chart point `d` px beyond a runway end, on the extended centreline. */
const beyond = (end: Px, d: number): Px => [end[0] + along[0] * d, end[1] + along[1] * d];

/** Screen angle (deg, counter-clockwise from east) of the runway on a north-up map. */
export const RUNWAY_SCREEN_ANGLE = (Math.atan2(-(RWY.e[1] - RWY.w[1]), RWY.e[0] - RWY.w[0]) * 180) / Math.PI;

export const RUNWAYS: Runway[] = [
  {
    id: "08/26",
    label: "RUNWAY 08/26 · 2687 × 46 m",
    widthM: 46,
    path: path([RWY.w, RWY.e]),
    ends: [
      { designator: "08", heading: "079°", position: ll(RWY.w), outward: ll(beyond(RWY.w, -60)) },
      { designator: "26", heading: "259°", position: ll(RWY.e), outward: ll(beyond(RWY.e, 60)) },
    ],
  },
];

// ---------------------------------------------------------------- taxiways

/** Parallel taxiway A, north of the runway: y = 553 - 0.3243 (x - 600) on the chart. */
const ay = (x: number) => 553 - 0.3243 * (x - 600);

const TAXIWAY_PX: Record<string, Px[]> = {
  A: [[305, 760], [290, 712], [296, 670], [340, ay(340)], [1530, ay(1530)], [1546, 258], [1562, 350]],
  A1: [[1386, ay(1386)], [1392, 408]],
  // ramp connectors from A up to the north apron
  AN1: [[620, ay(620)], [618, 522]],
  AN2: [[700, ay(700)], [698, 496]],
  AN3: [[790, ay(790)], [788, 468]],
  AN4: [[870, ay(870)], [868, 442]],
  AN5: [[1255, ay(1255)], [1240, 300]],
  // south side
  E: [[555, 732], [1182, 520]],
  E1: [[1182, 520], [1170, 478]],
  E4: [[555, 732], [538, 690]],
  D: [[652, 652], [663, 686], [737, 875], [792, 982]],
  C: [[721, 628], [731, 668], [800, 851], [832, 962]],
  B: [[866, 580], [872, 617], [846, 690], [836, 770], [850, 835], [880, 958]],
  W: [[640, 722], [620, 765], [612, 790]],
};

export const TAXIWAYS = Object.entries(TAXIWAY_PX).map(([id, pts]) => ({ id, path: path(pts) }));
export const TAXIWAY_WIDTH_M = 15;

// ---------------------------------------------------------------- aprons, buildings

/** The public event under the runway 26 approach: SYNTHETIC, not on the chart. */
const EVENT_CENTRE = beyond(RWY.e, 560);
const EVENT_PX: Px[] = [
  [EVENT_CENTRE[0] - 120, EVENT_CENTRE[1] + 20],
  [EVENT_CENTRE[0] - 40, EVENT_CENTRE[1] - 50],
  [EVENT_CENTRE[0] + 110, EVENT_CENTRE[1] - 70],
  [EVENT_CENTRE[0] + 140, EVENT_CENTRE[1] + 30],
  [EVENT_CENTRE[0] + 30, EVENT_CENTRE[1] + 95],
  [EVENT_CENTRE[0] - 90, EVENT_CENTRE[1] + 80],
];

const AREA_PX: { id: string; kind: Area["kind"]; px: Px[] }[] = [
  // aprons
  { id: "north-ramp", kind: "apron", px: [[553, 452], [935, 332], [1000, 318], [1040, 412], [862, 466], [572, 548], [558, 500]] },
  { id: "ne-ramp", kind: "apron", px: [[1212, 262], [1282, 262], [1290, 312], [1222, 318]] },
  { id: "west-complex-apron", kind: "apron", px: rect(600, 762, 652, 808) },
  { id: "fbo-apron", kind: "apron", px: [[852, 700], [900, 690], [935, 715], [965, 770], [968, 832], [880, 840], [858, 790]] },
  { id: "south-apron", kind: "apron", px: rect(788, 948, 852, 1000) },
  { id: "sw-apron", kind: "apron", px: rect(694, 952, 742, 992) },
  // the event site (synthetic)
  { id: "event-site", kind: "outline", px: EVENT_PX },
  // north ramp hangars
  { id: "n-bldg-1", kind: "building", px: rect(546, 432, 560, 446) },
  { id: "n-bldg-2", kind: "building", px: rect(576, 400, 600, 436) },
  { id: "n-hangar-1", kind: "building", px: [[610, 384], [662, 372], [668, 404], [616, 418]] },
  { id: "n-hangar-2", kind: "building", px: [[680, 356], [790, 322], [830, 330], [842, 362], [700, 396]] },
  { id: "n-bldg-3", kind: "building", px: rect(866, 326, 900, 344) },
  { id: "n-bldg-4", kind: "building", px: [[905, 306], [935, 300], [940, 320], [910, 326]] },
  { id: "n-bldg-5", kind: "building", px: [[950, 292], [985, 284], [990, 304], [955, 312]] },
  // north-east site
  { id: "ne-bldg-1", kind: "building", px: rect(1230, 214, 1250, 240) },
  { id: "ne-bldg-2", kind: "building", px: [[1266, 228], [1345, 236], [1344, 246], [1265, 238]] },
  { id: "ne-bldg-3", kind: "building", px: rect(1210, 266, 1226, 280) },
  // south side
  { id: "fbo-terminal", kind: "terminal", px: rect(908, 698, 926, 710) },
  { id: "east-complex", kind: "building", px: [[860, 726], [874, 722], [886, 756], [872, 762]] },
  { id: "t-hangars-1", kind: "building", px: rect(912, 768, 962, 776) },
  { id: "t-hangars-2", kind: "building", px: rect(912, 782, 966, 790) },
  { id: "t-hangars-3", kind: "building", px: rect(912, 796, 966, 804) },
  { id: "e-hangar-1", kind: "building", px: rect(886, 836, 906, 852) },
  { id: "e-hangar-2", kind: "building", px: [[902, 852], [956, 840], [962, 862], [906, 876]] },
  { id: "e-hangar-3", kind: "building", px: rect(906, 882, 940, 914) },
  { id: "west-complex-1", kind: "building", px: [[578, 788], [606, 778], [616, 808], [590, 816]] },
  { id: "west-complex-2", kind: "building", px: [[616, 810], [640, 804], [652, 828], [628, 832]] },
  { id: "south-hangar", kind: "building", px: rect(806, 964, 838, 990) },
  { id: "sw-hangar", kind: "building", px: [[640, 975], [690, 958], [702, 990], [690, 1015], [640, 1030], [632, 1010], [660, 1000]] },
];

export const AREAS: Area[] = AREA_PX.map((a) => ({ id: a.id, kind: a.kind, polygon: ring(a.px) }));

// ---------------------------------------------------------------- labels

const L = (text: string, p: Px, kind: MapLabel["kind"], angle?: number): MapLabel => ({ text, position: ll(p), kind, ...(angle !== undefined ? { angle } : {}) });

export const LABELS: MapLabel[] = [
  L("NORTH RAMP · HANGARS", [790, 300], "minor"),
  L("PUBLIC EVENT (SYNTHETIC)", [EVENT_CENTRE[0], EVENT_CENTRE[1] + 125], "major"),
  L("FBO TERMINAL", [960, 700], "minor"),
  L("EAST COMPLEX", [1000, 790], "minor"),
  L("WEST COMPLEX", [590, 845], "minor"),
  L("SOUTH HANGAR", [822, 1015], "minor"),
  L("T-HANGARS", [990, 860], "minor"),
  L("RUNWAY 08/26 · 2687 × 46 m", [880, 578], "runway", RUNWAY_SCREEN_ANGLE),
  L("A", [1100, ay(1100)], "taxiway"),
  L("B", [848, 760], "taxiway"),
  L("C", [790, 820], "taxiway"),
  L("D", [722, 835], "taxiway"),
  L("E", [1000, 582], "taxiway"),
];

/** Chart extent plus the event site, for fitting the view. */
export const CHART_BOUNDS = { sw: ll([100, 1060]), ne: ll([Math.max(1700, EVENT_CENTRE[0] + 160), 180]) };

/** Chart pixels of points the scenario and tests refer to. */
export const MRB_PX = { runway: RWY, event: EVENT_CENTRE, beyond };

export const MRB_LAYOUT: AirportLayout = {
  icao: "KMRB",
  ARP,
  RUNWAYS,
  TAXIWAYS,
  TAXIWAY_WIDTH_M,
  AREAS,
  LABELS,
  RUNWAY_SCREEN_ANGLE,
  CHART_BOUNDS,
  // the dead CAM-08 sector to the west, the callers' drone 3 km south, the event and the arriving jet to the east,
  // and the nearest blind ground (2.5 km north, beyond the RF detector) on screen
  FIT_KM: { west: 3.4, south: 3.2, east: 3.7, north: 2.9 },
  credit: "LAYOUT AFTER FOREFLIGHT DIAGRAM",
};

/** The traced geometry in chart pixels, for overlay checks against the source chart. */
export const TRACE = { runways: [RWY], taxiways: TAXIWAY_PX, areas: AREA_PX };
