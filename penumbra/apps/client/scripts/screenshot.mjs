/**
 * Capture a frozen frame of the offline client with headless Chromium.
 *
 *   pnpm shot                         # key frame 14:41:22 -> docs/screens/keyframe.png
 *   pnpm shot -- --t 14:39:30 --out docs/screens/1439.png --scale 1
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    t: { type: "string", default: "14:41:22" },
    out: { type: "string", default: resolve(here, "../../../docs/screens/keyframe.png") },
    width: { type: "string", default: "1600" },
    height: { type: "string", default: "900" },
    scale: { type: "string", default: "2" },
    port: { type: "string", default: "4179" },
    query: { type: "string", default: "" },
  },
});

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = await import("playwright"));
}

const viteBin = resolve(here, "../node_modules/vite/bin/vite.js");
const vite = spawn(process.execPath, [viteBin, "--port", values.port, "--strictPort", "--host", "127.0.0.1"], { cwd: resolve(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
const stop = () => vite.exitCode === null && vite.kill("SIGTERM");
process.on("exit", stop);
await new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error("vite did not start")), 30000);
  vite.stdout.on("data", (d) => /Local/.test(String(d)) && (clearTimeout(timer), ok()));
  vite.on("exit", (code) => fail(new Error(`vite exited ${code}`)));
});

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport: { width: Number(values.width), height: Number(values.height) }, deviceScaleFactor: Number(values.scale) });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${values.port}/?t=${values.t}${values.query ? `&${values.query}` : ""}`);
  await page.waitForFunction(() => window.__penumbra?.model, null, { timeout: 30000 });
  await page.waitForTimeout(2500); // symbol icons and the font atlas load asynchronously
  mkdirSync(dirname(values.out), { recursive: true });
  await page.screenshot({ path: values.out });
  console.log(`saved ${values.out}`);
  if (errors.length) console.log(`console errors:\n  ${errors.join("\n  ")}`);
} finally {
  await browser.close();
  stop();
}
process.exit(0);
