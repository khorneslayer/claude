/**
 * Legibility probe end to end, in a headless browser: take the probe as a
 * participant would, clicking the right answer on the map for five trials and
 * "Can't tell" on one, then check the summary and the session log.
 *
 *   pnpm --filter @penumbra/client probe:smoke
 *   PROBE_SCENARIO=mrb pnpm probe:smoke        # the same on the KMRB low-cost scenario
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)("playwright");
const PORT = String(5600 + Math.floor(Math.random() * 300));
const FEED_PORT = String(9300 + Math.floor(Math.random() * 300));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
const sessionsDir = mkdtempSync(join(tmpdir(), "penumbra-probe-"));
const SCENARIO = process.env.PROBE_SCENARIO ?? "ber";
const SCENARIO_ID = { ber: "ber-south-uas-surge", mrb: "mrb-lowcost-approach" }[SCENARIO];

let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

// A feed server only for its session store, so the answers land on disk like in a real study.
const feed = spawn(process.execPath, [tsx, "apps/server/src/main.ts", "--port", FEED_PORT, "--sessions-dir", sessionsDir, "--paused"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
const vite = spawn(process.execPath, [resolve(here, "../node_modules/vite/bin/vite.js"), "--port", PORT, "--strictPort", "--host", "127.0.0.1"], {
  cwd: resolve(here, ".."),
  env: { ...process.env, PENUMBRA_FEED: `http://127.0.0.1:${FEED_PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const stop = () => {
  for (const p of [vite, feed]) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
  }
};
process.on("exit", stop);

try {
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("feed server did not start")), 30000);
    feed.stdout.on("data", (d) => /websocket/.test(String(d)) && (clearTimeout(t), ok()));
  });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("vite did not start")), 30000);
    vite.stdout.on("data", (d) => /Local/.test(String(d)) && (clearTimeout(t), ok()));
  });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?probe&scenario=${SCENARIO}`);
  await page.getByRole("dialog", { name: "Legibility probe" }).waitFor({ timeout: 30000 });
  await page.getByLabel("Participant id").fill("P-SMOKE");
  await page.getByRole("button", { name: "Start" }).click();

  const SKIP = 2;
  for (let i = 0; i < 6; i++) {
    await page.getByRole("button", { name: "Show the picture" }).click();
    await page.locator(".probe-bar").waitFor({ timeout: 15000 });
    await page.waitForFunction((n) => window.__probe?.trial.index === n, i, { timeout: 15000 });
    await page.waitForTimeout(800); // let the frozen frame settle
    const probe = await page.evaluate(() => window.__probe);
    if (i === SKIP) {
      await page.getByRole("button", { name: /Can.t tell/ }).click();
      continue;
    }
    let lonLat;
    if (probe.trial.question === "blind") {
      lonLat = [probe.blindPoint.lon, probe.blindPoint.lat];
    } else {
      const id = probe.expected.ids[0];
      lonLat = await page.evaluate((id) => {
        const p = window.__penumbra;
        const g = p.view === "legacy" ? p.legacy.find((t) => t.id === id) : p.model.glyphs.find((x) => x.entityId === id);
        return g?.position;
      }, id);
    }
    const xy = await page.evaluate((ll) => window.__penumbra.project(ll), lonLat);
    console.log(`      trial ${i + 1}: ${probe.trial.view} ${probe.trial.question} -> click ${JSON.stringify(lonLat)} at ${xy?.map((v) => Math.round(v))}`);
    // Move, settle, press: deck.gl picks on hover, which takes a frame or two in software GL.
    await page.mouse.move(xy[0], xy[1]);
    await page.waitForTimeout(400);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
    if (process.env.DEBUG_PROBE) await page.screenshot({ path: `${process.env.DEBUG_PROBE}/probe-${i}.png` });
  }

  await page.getByRole("dialog", { name: "Probe results" }).waitFor({ timeout: 15000 });
  const rows = await page.locator(".probe-summary tbody tr").allInnerTexts();
  const events = await page.evaluate(() => window.__penumbra.recorder.events.map((e) => ({ kind: e.kind, data: e.data })));
  const answers = events.filter((e) => e.kind === "probe_answer");
  check(answers.length === 6, `six answers recorded (${answers.length})`);
  check(answers.filter((a) => a.data.correct).length === 5, `five correct, one "can't tell" (${answers.map((a) => (a.data.correct ? "✓" : "✗")).join(" ")})`);
  check(answers.every((a) => a.data.latencyMs > 0), "every answer has a latency");
  check(answers.every((a) => a.data.scenario === SCENARIO_ID), `every answer names its scenario (${SCENARIO_ID})`);
  check(new Set(answers.map((a) => a.data.at)).size === 2 && new Set(answers.map((a) => a.data.view)).size === 2, "both views, at two different moments");
  check(events.some((e) => e.kind === "probe_done"), "probe_done recorded with the summary");
  check(rows.length === 2 && rows.some((r) => /PENUMBRA/.test(r)) && rows.some((r) => /LEGACY/.test(r)), `summary table: ${rows.map((r) => r.replace(/\s+/g, " ")).join(" | ")}`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.evaluate(() => window.__penumbra.recorder.flush());
  await page.waitForTimeout(500);
  await browser.close();

  // The session reached the server, and the report reads it.
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  const stored = files.flatMap((f) => readFileSync(join(sessionsDir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  check(files.length === 1 && stored.filter((e) => e.kind === "probe_answer").length === 6, `session stored on the server (${files.length} file, ${stored.filter((e) => e.kind === "probe_answer").length} answers)`);
  const report = execFileSync(process.execPath, [tsx, "apps/server/src/probe-report.ts", ...files.map((f) => join(sessionsDir, f))], { cwd: root, encoding: "utf8" });
  check(/\| PENUMBRA \| 3 \| 100 % \|/.test(report) && /\| LEGACY \| 3 \| 67 % \|/.test(report), "probe:report aggregates the stored session");
  console.log(report.split("\n").map((l) => `      ${l}`).join("\n"));
} catch (e) {
  check(false, String(e));
} finally {
  stop();
}
process.exit(failed ? 1 : 0);
