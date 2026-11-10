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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const procs = [];
const start = (cmd, args, cwd, ready, env = {}) =>
  new Promise((ok, fail) => {
    // Own process group, so the whole tree (tsx -> node) is stopped at the end.
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error(`${args.join(" ")} did not start`)), 30000);
    const onData = (d) => ready.test(String(d)) && (clearTimeout(timer), ok());
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("exit", (code) => fail(new Error(`${args.join(" ")} exited ${code}`)));
  });
const stopAll = () =>
  procs.forEach((p) => {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  });
process.on("exit", stopAll);

// Random ports, so a run never talks to a server left over from the previous one.
const FEED_PORT = String(8800 + Math.floor(Math.random() * 400));
const WEB_PORT = String(5200 + Math.floor(Math.random() * 400));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

try {
  const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
  // A throwaway sessions folder, so test runs never mix with real study sessions.
  const sessionsDir = mkdtempSync(join(tmpdir(), "penumbra-smoke-"));
  await start(process.execPath, [tsx, "apps/server/src/main.ts", "--port", FEED_PORT, "--speed", "8", "--manual", "--sessions-dir", sessionsDir], root, /websocket/);
  await start(process.execPath, [resolve(here, "../node_modules/vite/bin/vite.js"), "--port", WEB_PORT, "--strictPort", "--host", "127.0.0.1"], resolve(here, ".."), /Local/, {
    PENUMBRA_FEED: `http://127.0.0.1:${FEED_PORT}`,
  });

  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await page.waitForFunction(() => window.__penumbra?.model?.glyphs.length > 0, null, { timeout: 30000 });

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
  // M3: the operator resolves CTR-004 from the provenance panel.
  const ctr = await page
    .waitForFunction(() => window.__penumbra.cards?.some((c) => c.id === "CTR-004"), null, { timeout: 20000 })
    .then(() => true, () => false);
  check(ctr, "CTR-004 appears in the contradiction register");
  const sel = await page.evaluate(() => window.__penumbra.selection);
  check(sel?.entityId === "TRK-1155" && sel?.label === "CAND-A", `provenance opens on TRK-1155 CAND-A (${JSON.stringify(sel)})`);
  const panelText = await page.locator(".panel.right").innerText();
  check(/PROVENANCE · CAND-A/i.test(panelText) && /Bearing only/.test(panelText), "provenance panel shows CAND-A with its RF bearing row");
  await page.getByRole("button", { name: /Resolve · hobbyist/i }).click();
  const resolved = await page
    .waitForFunction(() => window.__penumbra.snap.contradictions.find((c) => c.id === "CTR-004")?.status === "resolved", null, { timeout: 10000 })
    .then(() => true, () => false);
  check(resolved, "clicking RESOLVE resolves CTR-004 on the live picture");
  const toastText = await page.locator(".toast").innerText().catch(() => "");
  check(/CTR-004 resolved as hobbyist · OP-1/.test(toastText), `confirmation shown ("${toastText}")`);
  const log = await (await fetch(`http://127.0.0.1:${FEED_PORT}/log.jsonl`)).text();
  const op = log.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "operator_action" && e.operatorId === "OP-1");
  check(op?.value === "hobbyist", "the server's append-only log records OP-1's decision");
  // D must be refused while CTR-004 stands resolved (a later contrary call may legitimately reopen it).
  const statusNow = await page.evaluate(() => window.__penumbra.snap.contradictions.find((c) => c.id === "CTR-004")?.status);
  if (statusNow === "resolved") {
    await page.keyboard.press("d");
    await page.waitForTimeout(500);
    const toast2 = await page.locator(".toast").innerText().catch(() => "");
    check(!/deferred/.test(toast2), "D does nothing once CTR-004 is resolved");
  } else {
    console.log(`      (CTR-004 already ${statusNow}: a contrary call arrived after the decision; D check skipped)`);
  }

  // M4: replay from a timeline mark, then back to live. Pause first so the marks stand still.
  if (await page.evaluate(() => window.__penumbra.store.clock.playing)) await page.keyboard.press("Space");
  await page.waitForFunction(() => !window.__penumbra.store.clock.playing, null, { timeout: 5000 });
  // The live status before replay: resolved, or reopened if a contrary call arrived after OP-1's decision.
  const liveCtr = await page.evaluate(() => window.__penumbra.snap.contradictions.find((c) => c.id === "CTR-004")?.status);
  await page.locator('.tl-controls').getByRole("button", { name: "5M", exact: true }).click();
  await page.locator('.tl-mark.contradiction[aria-label*="CTR-004 opened"]').click();
  const replay = await page.evaluate(() => ({
    replayT: window.__penumbra.replayT,
    t: window.__penumbra.snap.t,
    head: window.__penumbra.head,
    ctr: window.__penumbra.snap.contradictions.find((c) => c.id === "CTR-004")?.status,
  }));
  check(replay.replayT !== undefined && replay.t < replay.head, `clicking the CTR-004 mark replays that moment (${JSON.stringify(replay)})`);
  check(replay.ctr === "unresolved", `the replay shows CTR-004 as it stood then: ${replay.ctr} (resolved later)`);
  check(await page.locator(".replay-banner").isVisible(), "replay banner is shown");
  check(await page.locator(".actions .resolve").isDisabled(), "actions are disabled during replay");
  await page.keyboard.press("End");
  await page
    .waitForFunction(() => window.__penumbra.replayT === undefined, null, { timeout: 10000 })
    .catch(() => {});
  const back = await page.evaluate(() => ({
    replayT: window.__penumbra.replayT,
    ctr: window.__penumbra.snap.contradictions.find((c) => c.id === "CTR-004")?.status,
    t: window.__penumbra.snap.t,
    head: window.__penumbra.head,
    ops: window.__penumbra.snap.operatorActions.map((a) => `${a.operatorId}:${a.action}:${a.t}`),
    active: document.activeElement?.className,
  }));
  check(back.replayT === undefined && back.t === back.head && back.ctr === liveCtr, `End returns to the live picture (CTR-004 ${back.ctr} again)`);

  // M4: LEGACY view and back.
  await page.keyboard.press("v");
  await page.waitForFunction(() => window.__penumbra.view === "legacy" && window.__penumbra.legacy?.length > 0, null, { timeout: 10000 }).catch(() => {});
  const legacyText = await page.locator(".panel.left").innerText();
  const legacy = await page.evaluate(() => ({ view: window.__penumbra.view, ids: window.__penumbra.legacy.map((t) => t.id) }));
  check(legacy.view === "legacy" && /TRACK LIST/i.test(legacyText), "V switches to the LEGACY view with a track list");
  check(legacy.ids.includes("TRK-1155") && !legacy.ids.some((id) => id.includes("CAND")), "LEGACY shows one fused track per contact");
  await page.locator(".tracks tr", { hasText: "TRK-1155" }).click();
  check(/Track quality\s*\d+ \/ 15/i.test(await page.locator(".panel.right").innerText()), "LEGACY track details show track quality");
  await page.keyboard.press("v");
  await page.waitForFunction(() => window.__penumbra.view === "penumbra", null, { timeout: 10000 }).catch(() => {});
  await page.locator(".panel.left .panel-title.alert").waitFor({ timeout: 10000 }).catch(() => {});
  check(/CONTRADICTION REGISTER/i.test(await page.locator(".panel.left").innerText()), "V switches back to PENUMBRA");

  // M5: every interaction reached the server's session log.
  await page.evaluate(() => window.__penumbra.recorder.flush());
  await page.waitForTimeout(800);
  const local = await page.evaluate(() => ({ id: window.__penumbra.recorder.id, kinds: window.__penumbra.recorder.events.map((e) => e.kind) }));
  const stored = await (await fetch(`http://127.0.0.1:${FEED_PORT}/api/sessions/${local.id}`)).text();
  const storedKinds = stored.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).kind);
  check(storedKinds.length === local.kinds.length, `session log on the server matches the browser (${storedKinds.length}/${local.kinds.length} events)`);
  check(["control", "action_request", "action_result", "replay", "live", "view"].every((k) => storedKinds.includes(k)), `interactions recorded: ${[...new Set(storedKinds)].join(", ")}`);

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (e) {
  check(false, String(e));
} finally {
  stopAll();
}
process.exit(failed ? 1 : 0);
