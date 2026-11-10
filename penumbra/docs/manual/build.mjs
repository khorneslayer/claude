/**
 * Build the PENUMBRA manual (Stratosphere design) to PDF with headless Chromium.
 *
 *   pnpm manual            # -> docs/manual/PENUMBRA-Manual.pdf
 *
 * Screenshots come from docs/screens/ (refresh them with `pnpm shot`); fonts
 * from the @fontsource packages (OFL), so the PDF is identical on any machine.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)("playwright");
const out = resolve(here, "PENUMBRA-Manual.pdf");

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(resolve(here, "manual.html")).href, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
  });
  const missing = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")));
  if (missing.length) throw new Error(`images not found: ${missing.join(", ")}`);
  const fonts = await page.evaluate(() => ["Anton", "Inter", "JetBrains Mono"].filter((f) => !document.fonts.check(`12px "${f}"`)));
  if (fonts.length) throw new Error(`fonts not loaded: ${fonts.join(", ")}`);
  await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
}
