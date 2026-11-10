/**
 * Record the scripted demo to a video at exactly 1920 x 1080.
 *
 *   pnpm demo:record                 # real time (about 4 minutes), best on a machine with a GPU
 *   pnpm demo:record -- --speed 4    # faster run (for checking the cues)
 *
 * Output: recordings/penumbra-demo-<timestamp>.webm (git-ignored).
 */
import { spawn } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { values } = parseArgs({ options: { speed: { type: "string", default: "1" }, out: { type: "string" } } });
const speed = Number(values.speed);
const { chromium } = createRequire(import.meta.url)("playwright");
const FEED_PORT = String(9600 + Math.floor(Math.random() * 300));
const WEB_PORT = String(6000 + Math.floor(Math.random() * 300));
const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");

const procs = [];
const start = (args, cwd, ready, env = {}) =>
  new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    procs.push(p);
    const t = setTimeout(() => fail(new Error(`${args[1]} did not start`)), 30000);
    p.stdout.on("data", (d) => ready.test(String(d)) && (clearTimeout(t), ok()));
  });
const stopAll = () =>
  procs.forEach((p) => {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
  });
process.on("exit", stopAll);

const outDir = resolve(root, "recordings");
mkdirSync(outDir, { recursive: true });
try {
  // Scripted feed (the scenario's own operator decisions), paused until the demo starts it.
  await start([tsx, "apps/server/src/main.ts", "--port", FEED_PORT, "--paused", "--no-sessions"], root, /websocket/);
  await start([resolve(here, "../node_modules/vite/bin/vite.js"), "--port", WEB_PORT, "--strictPort", "--host", "127.0.0.1"], resolve(here, ".."), /Local/, {
    PENUMBRA_FEED: `http://127.0.0.1:${FEED_PORT}`,
  });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/?demo&capture=1080p&speed=${speed}`);
  const budgetMs = ((210 / speed) + 30) * 1000;
  const t0 = Date.now();
  await page.waitForFunction(() => window.__penumbra?.demoDone === true, null, { timeout: budgetMs, polling: 1000 });
  const cues = await page.evaluate(() => window.__penumbra.recorder.events.filter((e) => e.kind === "demo_cue").length);
  const video = page.video();
  await context.close();
  await browser.close();
  const raw = await video.path();
  const out = values.out ? resolve(values.out) : join(outDir, `penumbra-demo-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.webm`);
  renameSync(raw, out);
  console.log(`recorded ${cues} cues in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${out}`);
} finally {
  stopAll();
}
process.exit(0);
