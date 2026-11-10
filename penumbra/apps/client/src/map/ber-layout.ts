/**
 * Berlin Brandenburg (EDDB) airport layout, traced from the "Airport Layout
 * 08/2026" chart by R. Aehnelt, Wikimedia Commons (Creative Commons; check the
 * exact licence before any external use). NOT FOR OPERATIONAL USE / NAVIGATION.
 *
 * Geometry is kept in chart pixels (2000 x 1414 image) exactly as traced and
 * converted to lat/lon through a georeference fitted to the chart itself:
 *   scale     1,000 m = 327 px (chart scale bar; runway lengths agree within 0.5 %)
 *   rotation  chart "right" = true bearing 070 deg (north arrow ~20 deg east of up;
 *             runways 065 deg magnetic + ~5 deg east declination)
 *   anchor    chart ARP N 52 22' 00" E 13 30' 12" at the midpoint of the runway centres
 */
import { offsetM, type LatLon } from "@penumbra/core";

export type Px = [number, number];
export type LonLat = [number, number];

export const ARP: LatLon = { lat: 52 + 22 / 60, lon: 13 + 30 / 60 + 12 / 3600 };
const ARP_PX: Px = [1056, 960];
export const METRES_PER_PX = 1000 / 327;
const RIGHT_BEARING = 70; // true bearing of the chart's +x axis
const UP_BEARING = RIGHT_BEARING - 90; // true bearing of the chart's -y axis

const rad = (d: number) => (d * Math.PI) / 180;

/** Chart pixel -> lat/lon. */
export function pxToLatLon([x, y]: Px): LatLon {
  const u = (x - ARP_PX[0]) * METRES_PER_PX; // along 070
  const v = (ARP_PX[1] - y) * METRES_PER_PX; // along 340
  const east = u * Math.sin(rad(RIGHT_BEARING)) + v * Math.sin(rad(UP_BEARING));
  const north = u * Math.cos(rad(RIGHT_BEARING)) + v * Math.cos(rad(UP_BEARING));
  return offsetM(ARP, east, north);
}

const ll = (p: Px): LonLat => {
  const g = pxToLatLon(p);
  return [g.lon, g.lat];
};
const path = (pts: Px[]) => pts.map(ll);
const ring = (pts: Px[]) => {
  const r = pts.map(ll);
  return [...r, r[0]!];
};
const rect = (x0: number, y0: number, x1: number, y1: number): Px[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

// ---------------------------------------------------------------- runways

export interface Runway {
  id: string;
  label: string;
  widthM: number;
  path: LonLat[];
  ends: { designator: string; heading: string; position: LonLat; outward: LonLat }[];
}

const RWY_N = { w: [705, 647] as Px, e: [1878, 647] as Px };
const RWY_S = { w: [165, 1272] as Px, e: [1475, 1272] as Px };

export const RUNWAYS: Runway[] = [
  {
    id: "06L/24R",
    label: "RUNWAY NORTH · 3600 × 45 m",
    widthM: 45,
    path: path([RWY_N.w, RWY_N.e]),
    ends: [
      { designator: "06L", heading: "065°", position: ll(RWY_N.w), outward: ll([RWY_N.w[0] - 60, RWY_N.w[1]]) },
      { designator: "24R", heading: "245°", position: ll(RWY_N.e), outward: ll([RWY_N.e[0] + 60, RWY_N.e[1]]) },
    ],
  },
  {
    id: "06R/24L",
    label: "RUNWAY SOUTH · 4000 × 60 m",
    widthM: 60,
    path: path([RWY_S.w, RWY_S.e]),
    ends: [
      { designator: "06R", heading: "065°", position: ll(RWY_S.w), outward: ll([RWY_S.w[0] - 60, RWY_S.w[1]]) },
      { designator: "24L", heading: "245°", position: ll(RWY_S.e), outward: ll([RWY_S.e[0] + 60, RWY_S.e[1]]) },
    ],
  },
];

/** Screen angle (deg, counter-clockwise from east) of the runways on a north-up map. */
export const RUNWAY_SCREEN_ANGLE = 90 - RIGHT_BEARING;

// ---------------------------------------------------------------- taxiways

export interface Taxiway {
  id: string;
  path: LonLat[];
}

const TAXIWAY_PX: Record<string, Px[]> = {
  // between the runways, north side
  D: [[700, 729], [1838, 729]],
  C: [[700, 761], [1840, 761]],
  L1: [[712, 647], [712, 729]],
  L2: [[745, 647], [745, 729]],
  L3: [[955, 647], [1010, 690], [1062, 729]],
  L4: [[1240, 647], [1192, 690], [1152, 729]],
  L5: [[1400, 647], [1448, 690], [1482, 729]],
  L6: [[1612, 647], [1572, 690], [1542, 729]],
  L7: [[1785, 647], [1785, 761]],
  L8: [[1878, 647], [1878, 705], [1852, 745], [1815, 761]],
  F: [[1300, 761], [1300, 780]],
  Y1: [[1515, 761], [1500, 790]],
  // between the runways, south side
  T: [[697, 729], [697, 1192]],
  P: [[982, 761], [982, 1192]],
  V: [[1138, 761], [1138, 1192]],
  E: [[1180, 1142], [1425, 1142]],
  B: [[130, 1160], [1515, 1160]],
  A: [[130, 1192], [1515, 1192]],
  M1: [[140, 1160], [140, 1272]],
  M2: [[175, 1160], [175, 1272]],
  M3: [[560, 1192], [600, 1235], [640, 1272]],
  M5: [[730, 1192], [880, 1272]],
  M4: [[880, 1192], [730, 1272]],
  M6: [[1010, 1192], [940, 1272]],
  M7: [[1150, 1192], [1080, 1272]],
  M8: [[1470, 1160], [1470, 1272]],
  M9: [[1500, 1160], [1500, 1272]],
  // north of runway north
  K1: [[800, 647], [865, 585], [1000, 553], [1400, 457], [1480, 447]],
  K2: [[1110, 647], [1090, 585], [1110, 535]],
  K3: [[1490, 647], [1532, 560], [1620, 415]],
  G: [[1400, 457], [1500, 470], [1570, 485], [1880, 485]],
  K4: [[1785, 300], [1785, 647]],
  K5: [[1810, 300], [1810, 647]],
  K6: [[1878, 270], [1878, 647]],
  K: [[1620, 405], [1820, 405]],
  H: [[1700, 405], [1738, 290]],
  N1: [[1660, 300], [1880, 300]],
};

export const TAXIWAYS: Taxiway[] = Object.entries(TAXIWAY_PX).map(([id, pts]) => ({ id, path: path(pts) }));
export const TAXIWAY_WIDTH_M = 23;

// ---------------------------------------------------------------- aprons, buildings

export interface Area {
  id: string;
  polygon: LonLat[];
  kind: "apron" | "building" | "terminal" | "outline";
}

const AREA_PX: { id: string; kind: Area["kind"]; px: Px[] }[] = [
  // aprons
  { id: "ramps-a-e", kind: "apron", px: [[950, 778], [1440, 778], [1440, 840], [1345, 840], [1345, 1083], [1430, 1083], [1430, 1146], [950, 1146]] },
  { id: "maintenance-apron", kind: "apron", px: rect(645, 748, 690, 1045) },
  { id: "cargo-apron", kind: "apron", px: rect(1450, 785, 1545, 850) },
  { id: "ramp-4", kind: "apron", px: [[1570, 780], [1715, 780], [1715, 830], [1660, 860], [1570, 845]] },
  { id: "ramp-1", kind: "apron", px: [[1400, 390], [1480, 375], [1555, 420], [1555, 440], [1410, 455]] },
  { id: "ramp-2", kind: "apron", px: [[1570, 405], [1660, 280], [1710, 280], [1620, 405]] },
  { id: "ramp-3", kind: "apron", px: rect(1720, 160, 1880, 310) },
  { id: "ramp-3b", kind: "apron", px: rect(1820, 310, 1880, 430) },
  // the ExpoCenter grounds (dashed on the chart)
  {
    id: "expocenter",
    kind: "outline",
    px: [[328, 1040], [385, 1042], [390, 1068], [480, 1080], [480, 1135], [540, 1138], [540, 1155], [200, 1155], [200, 1145], [250, 1142], [290, 1118], [260, 1068], [328, 1065]],
  },
  // terminals
  { id: "terminal-1-frame", kind: "terminal", px: [[1210, 840], [1345, 840], [1345, 850], [1222, 850], [1222, 1073], [1345, 1073], [1345, 1083], [1210, 1083]] },
  { id: "terminal-1", kind: "terminal", px: rect(1222, 920, 1282, 993) },
  { id: "terminal-2", kind: "terminal", px: rect(1267, 852, 1345, 870) },
  { id: "terminal-5", kind: "terminal", px: [[1697, 198], [1832, 198], [1849, 160], [1857, 163], [1840, 218], [1697, 218]] },
  { id: "terminal-5-annex", kind: "terminal", px: rect(1675, 188, 1690, 210) },
  // other buildings
  { id: "tower", kind: "building", px: rect(1021, 940, 1034, 949) },
  { id: "hangar-1", kind: "building", px: rect(610, 748, 645, 782) },
  { id: "hangar-2", kind: "building", px: rect(627, 788, 645, 828) },
  { id: "hangar-3", kind: "building", px: rect(612, 890, 645, 916) },
  { id: "hangar-4", kind: "building", px: rect(610, 935, 645, 965) },
  { id: "hangar-5", kind: "building", px: rect(612, 992, 645, 1043) },
  { id: "acc", kind: "building", px: rect(620, 1095, 645, 1120) },
  { id: "fire-west", kind: "building", px: rect(580, 1092, 596, 1123) },
  { id: "fire-north", kind: "building", px: rect(1385, 360, 1425, 368) },
  { id: "fire-east", kind: "building", px: rect(1473, 1050, 1482, 1076) },
  { id: "government-terminal", kind: "building", px: [[1422, 380], [1460, 370], [1463, 378], [1425, 388]] },
  { id: "express-cargo", kind: "building", px: rect(1515, 340, 1537, 365) },
  { id: "cargo", kind: "building", px: rect(1475, 870, 1535, 892) },
  { id: "cargo-4a-1", kind: "building", px: [[1470, 806], [1510, 796], [1515, 806], [1475, 816]] },
  { id: "cargo-4a-2", kind: "building", px: [[1478, 828], [1520, 812], [1526, 824], [1484, 840]] },
  { id: "gat", kind: "building", px: [[1568, 795], [1576, 792], [1594, 836], [1632, 850], [1676, 850], [1676, 858], [1628, 858], [1586, 842]] },
  { id: "bizav-1", kind: "building", px: [[1668, 812], [1712, 796], [1720, 812], [1676, 830]] },
  { id: "bizav-2", kind: "building", px: [[1640, 828], [1662, 820], [1666, 830], [1644, 838]] },
  { id: "fuel-depot", kind: "building", px: [[1770, 862], [1782, 865], [1774, 898], [1762, 895]] },
  { id: "parking-1", kind: "building", px: rect(1297, 898, 1347, 914) },
  { id: "parking-2", kind: "building", px: rect(1355, 898, 1403, 914) },
  { id: "parking-3", kind: "building", px: rect(1297, 1008, 1347, 1024) },
  { id: "parking-4", kind: "building", px: rect(1267, 1047, 1333, 1066) },
  { id: "parking-5", kind: "building", px: rect(1225, 1020, 1253, 1065) },
];

export const AREAS: Area[] = AREA_PX.map((a) => ({ id: a.id, kind: a.kind, polygon: ring(a.px) }));

// ---------------------------------------------------------------- labels

export interface MapLabel {
  text: string;
  position: LonLat;
  kind: "major" | "minor" | "taxiway" | "runway";
  angle?: number;
}

const L = (text: string, p: Px, kind: MapLabel["kind"], angle?: number): MapLabel => ({ text, position: ll(p), kind, ...(angle !== undefined ? { angle } : {}) });

export const LABELS: MapLabel[] = [
  L("TERMINAL 1", [1290, 958], "major"),
  L("TERMINAL 2", [1306, 842], "minor"),
  L("TERMINAL 5 (CLOSED)", [1765, 180], "minor"),
  L("EXPOCENTER · PUBLIC EVENT", [365, 1170], "major"),
  L("RAMP A", [1300, 812], "minor"),
  L("RAMP B", [1188, 960], "minor", RUNWAY_SCREEN_ANGLE + 90),
  L("RAMP C", [1300, 1108], "minor"),
  L("RAMP D", [1092, 960], "minor", RUNWAY_SCREEN_ANGLE + 90),
  L("RAMP E", [972, 960], "minor", RUNWAY_SCREEN_ANGLE + 90),
  L("TWR", [1028, 926], "minor"),
  L("MAINTENANCE", [668, 900], "minor", RUNWAY_SCREEN_ANGLE + 90),
  L("EXPANSION AREA", [838, 905], "minor"),
  L("CARGO", [1505, 862], "minor"),
  L("GAT", [1590, 868], "minor"),
  L("BUSINESS AVIATION", [1660, 772], "minor"),
  L("FUEL DEPOT", [1776, 848], "minor"),
  L("ACC", [633, 1086], "minor"),
  L("FIRE STN W", [612, 1140], "minor"),
  L("FIRE STN N", [1405, 348], "minor"),
  L("FIRE STN E", [1478, 1092], "minor"),
  L("RAMP 1 (MIL)", [1470, 418], "minor"),
  L("RAMP 3", [1800, 270], "minor"),
  L("HELICOPTER", [1600, 448], "minor"),
  L("RUNWAY NORTH · 3600 × 45 m", [1330, 628], "runway", RUNWAY_SCREEN_ANGLE),
  L("RUNWAY SOUTH · 4000 × 60 m", [790, 1300], "runway", RUNWAY_SCREEN_ANGLE),
  L("A", [1300, 1194], "taxiway"),
  L("B", [1300, 1162], "taxiway"),
  L("C", [1300, 763], "taxiway"),
  L("D", [1300, 731], "taxiway"),
  L("E", [1300, 1144], "taxiway"),
  L("T", [697, 840], "taxiway"),
  L("K1", [1263, 492], "taxiway"),
  L("G", [1670, 487], "taxiway"),
];

/** Chart extent, for fitting the view. */
export const CHART_BOUNDS = { sw: ll([100, 1330]), ne: ll([1940, 140]) };

/** The traced geometry in chart pixels, for overlay checks against the source chart. */
export const TRACE = { runways: [RWY_N, RWY_S], taxiways: TAXIWAY_PX, areas: AREA_PX };
