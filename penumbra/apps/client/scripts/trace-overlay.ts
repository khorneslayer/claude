/**
 * Re-check the traced EDDB layout against the source chart.
 *
 *   npx tsx apps/client/scripts/trace-overlay.ts > trace.json
 *   python3 apps/client/scripts/trace-overlay.py <chart.png|webp> trace.json overlay.png
 *
 * The chart itself is not stored in the repository (Creative Commons; see docs/BASEMAP.md).
 */
import { TRACE } from "../src/map/ber-layout";

console.log(JSON.stringify(TRACE));
