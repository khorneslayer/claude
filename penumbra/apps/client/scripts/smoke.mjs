/**
 * Live-mode smoke test: real feed server + Vite dev proxy + headless Chromium.
 * Checks the client connects to the live feed, receives the log, and follows the head.
 *
 *   pnpm --filter @penumbra/client smoke
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const procs = [];
const start = (cmd, args, cwd, ready, env = {}) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error(`${args.join(" ")} did not start`)), 30000);
    const onData = (d) => ready.test(String(d)) && (clearTimeout(timer), ok());
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("exit", (code) => fail(new Error(`${args.join(" ")} exited ${code}`)));
  });
const stopAll = () => procs.forEach((p) => p.exitCode === null && p.kill("SIGTERM"));
process.on("exit", stopAll);

const FEED_PORT = "8791";
const WEB_PORT = "5191";
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

try {
  const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
  await start(process.execPath, [tsx, "apps/server/src/main.ts", "--port", FEED_PORT, "--speed", "8"], root, /websocket/);
  await start(process.execPath, [resolve(here, "../node_modules/vite/bin/vite.js"), "--port", WEB_PORT, "--strictPort", "--host", "127.0.0.1"], resolve(here, ".."), /Local/, {
    PENUMBRA_FEED: `http://127.0.0.1:${FEED_PORT}`,
  });

  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await page.waitForFunction(() => window.__penumbra?.model, null, { timeout: 30000 });

  const read = () => page.evaluate(() => ({ status: window.__penumbra.status, t: window.__penumbra.snap.t, seq: window.__penumbra.snap.logSeq, glyphs: window.__penumbra.model.glyphs.length, stats: { ...window.__penumbra.stats } }));
  const a = await read();
  // Software GL in CI is slow; wait for progress rather than a fixed interval.
  const advanced = await page
    .waitForFunction((t0) => window.__penumbra.snap.t > t0 + 5000, a.t, { timeout: 15000 })
    .then(() => true, () => false);
  const b = await read();
  check(a.status === "live", `client is on the live feed (status ${a.status})`);
  check(a.glyphs > 0, `picture has ${a.glyphs} glyphs`);
  check(advanced, `display time follows the live head (+${((b.t - a.t) / 1000).toFixed(1)} s sim)`);
  check(b.seq > a.seq, `log grows from the server (seq ${a.seq} -> ${b.seq})`);
  const st = b.stats;
  console.log(`      per tick (ms): evaluate ${st.evalMs.toFixed(1)} · render model ${st.modelMs.toFixed(1)} · layers ${st.layersMs.toFixed(1)} · ${st.ticks} ticks`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (e) {
  check(false, String(e));
} finally {
  stopAll();
}
process.exit(failed ? 1 : 0);
