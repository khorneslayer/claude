import { MapView, WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import DeckGL from "@deck.gl/react";
import { clockToMillis, formatElapsed, type Millis, type PictureSnapshot } from "@penumbra/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { connectLive } from "./feed/live";
import { startOffline } from "./feed/offline";
import { FeedStore } from "./feed/store";
import { buildCoverageLayers, buildDynamicLayers, buildLegacyLayers, buildStaticLayers } from "./map/layers";
import { buildLegacyModel, type LegacyTrack } from "./model/legacy";
import { timelineMarks } from "./model/timeline";
import { LegacyLeftPanel, LegacyRightPanel } from "./ui/LegacyPanels";
import { ReplayBanner, Timeline, type TimelineWindow } from "./ui/Timeline";
import { boundsAround, computeCoverageMask, coverageKey, LOST } from "./model/coverage";
import { defaultSelection, provenance, reconcileSelection, registerCards, sourceRows, type Lookups, type Selection } from "./model/panels";
import { placeLabels } from "./model/place";
import { buildRenderModel, sectorName, type FlagMarker, type Glyph } from "./model/view";
import { destination, distanceM, bearingDeg } from "@penumbra/core";
import { Header } from "./ui/Header";
import { Banner, Legend } from "./ui/Legend";
import { RightPanel, Toast } from "./ui/Provenance";
import { LeftPanel } from "./ui/Register";
import { Stats } from "./ui/Stats";
import { Caption } from "./demo/Captions";
import { cuesBetween, demoCuesFor, epilogue, type Cue } from "./demo/director";
import { layoutFor } from "./map/basemap";
import { scenarioKey } from "./scenarios";
import { ProbeRunner, type ProbeClick } from "./probe/ProbeRunner";
import { SessionRecorder } from "./session/recorder";

/**
 * URL parameters
 *   ?mode=offline        play the scenario in the browser (no server)
 *   ?scenario=mrb        offline scenario: ber (Berlin Brandenburg, default) or mrb (KMRB, low-cost kit);
 *                        a live feed plays whatever scenario the server was started with
 *   ?t=14:41:22          offline, frozen at that moment (screenshots, briefings)
 *   ?speed=4             initial playback speed
 *   ?ws=ws://host/ws     feed URL (default: same origin /ws, proxied to the server in dev)
 *   ?evalHz=10           local re-evaluation rate
 *   ?stress=500          offline, plus N synthetic three-source drones (performance check)
 *   ?stats               fps meter and per-tick timings
 *   ?op=OP-3             operator id for RESOLVE / DEFER (default OP-1)
 *   ?scripted            offline: keep the scenario's scripted decisions after playFrom
 *   ?view=legacy         open in the LEGACY view (toggle with V)
 *   ?replay=14:36:00     open replaying that moment (scrub with the timeline, arrow keys; End returns to live)
 *   ?probe               run the legibility probe (offline, both views, timed answers)
 *   ?demo                scripted walkthrough with captions (restarts the feed; offline fallback plays the scripted ending)
 *   ?capture=1080p       render at exactly 1920 x 1080, scaled to fit the window (for recording)
 */
const params = new URLSearchParams(window.location.search);
const FROZEN_AT = params.get("t") ?? undefined;
const EVAL_HZ = Number(params.get("evalHz") ?? 10);
const MAP_VIEW = new MapView({ repeat: false });
const STRESS = params.get("stress") ? Number(params.get("stress")) : undefined;
const SHOW_STATS = params.has("stats");
const OPERATOR = params.get("op") ?? "OP-1";
const SCRIPTED = params.has("scripted");
const SCENARIO = scenarioKey(params.get("scenario"));
/** Mock releasability marking (slide 6, item 08): visible without opening a dialogue. */
const MARKING = "EXERCISE · SYNTHETIC DATA · REL DEU/NLD (MOCK)";
export type ViewMode = "penumbra" | "legacy";
const PROBE = params.has("probe");
const DEMO = params.has("demo");
const CAPTURE = params.get("capture") === "1080p";
/** Probe and demo own the screen: no shortcuts, no transport, no view switch. */
const LOCKED = PROBE || DEMO;

if (CAPTURE || DEMO) {
  const root = document.documentElement;
  if (DEMO) root.classList.add("demo");
  if (CAPTURE) {
    root.classList.add("capture");
    const fit = () => root.style.setProperty("--capture-scale", String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
    fit();
    window.addEventListener("resize", fit);
  }
}

export function App() {
  const store = useMemo(() => new FeedStore(), []);
  // Session instrumentation. Context is read at log time through a ref.
  const ctx = useRef({ simT: undefined as number | undefined, view: "penumbra", replay: false, mode: PROBE ? "probe" : DEMO ? "demo" : "live" });
  const recorder = useMemo(() => {
    const r = new SessionRecorder(() => ctx.current);
    // Record transport controls wherever they come from.
    const control = store.control.bind(store);
    store.control = (cmd, speed) => {
      r.log("control", { command: cmd, ...(speed !== undefined ? { speed } : {}) });
      control(cmd, speed);
    };
    return r;
  }, [store]);
  const status = useSyncExternalStore(store.subscribe, () => store.status);
  const [liveSnap, setLiveSnap] = useState<PictureSnapshot>();
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  // Replay: undefined = following the live head.
  const [replayT, setReplayT] = useState<Millis>();
  const [view, setView] = useState<ViewMode>(params.get("view") === "legacy" ? "legacy" : "penumbra");
  const [tlWindow, setTlWindow] = useState<TimelineWindow>("15m");
  // The picture on screen: live, or exactly as it stood at the replay moment.
  const snap = useMemo(
    () => (replayT !== undefined && liveSnap ? store.snapshotAt(Math.min(replayT, liveSnap.t)) : liveSnap),
    // A replay only changes when the moment or the log changes, not on every live tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replayT, replayT === undefined ? liveSnap : version, store],
  );
  const [hovered, setHovered] = useState<string>();
  const booted = useRef(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      if (r.width > 0 && r.height > 0) setMapSize({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const stats = useRef({ evalMs: 0, modelMs: 0, layersMs: 0, ticks: 0 });

  // Boot: live feed if reachable, otherwise the offline player.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const speed = params.get("speed") ? Number(params.get("speed")) : undefined;
    recorder.log("session_start", { params: Object.fromEntries(params), operator: OPERATOR, userAgent: navigator.userAgent });
    const offline = () =>
      startOffline(store, {
        scenario: SCENARIO,
        ...(FROZEN_AT ? { at: FROZEN_AT, paused: true } : {}),
        ...(PROBE ? { atEnd: true, paused: true } : {}),
        ...(speed ? { speed } : {}),
        ...(STRESS ? { stress: STRESS } : {}),
        scripted: SCRIPTED || DEMO,
      });
    if (FROZEN_AT || STRESS || PROBE || params.get("mode") === "offline") {
      offline();
      // The probe plays offline, but its answers still go to the feed server's session store when one is reachable.
      if (PROBE)
        void fetch("/api/sessions")
          .then((r) => r.ok && recorder.enableRemote())
          .catch(() => {});
      return;
    }
    const url = params.get("ws") ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
    void connectLive(store, url).then((ok) => {
      if (!ok) return offline();
      recorder.enableRemote();
      if (DEMO) {
        // The demo owns the clock: start from the top at the requested speed.
        store.control("restart");
        store.control("speed", speed ?? 1);
        store.control("play");
      } else if (speed) store.control("speed", speed);
    });
  }, [store]);

  // Local evaluation loop: confidence decays and envelopes grow between server updates.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let lastKey = "";
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 1000 / EVAL_HZ) return;
      last = now;
      const t = store.headNow(now);
      if (t === undefined) return;
      const key = `${t}:${store.getVersion()}`;
      if (key === lastKey) return;
      lastKey = key;
      const t0 = performance.now();
      const next = store.evaluate(t);
      stats.current.evalMs = performance.now() - t0;
      stats.current.ticks++;
      setLiveSnap(next);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  // Space toggles play / pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !FROZEN_AT && !LOCKED && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        store.control(store.clock?.playing ? "pause" : "play");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const meta = store.meta;
  const replayParamDone = useRef(false);
  useEffect(() => {
    const at = params.get("replay");
    if (!at || !meta || replayParamDone.current) return;
    replayParamDone.current = true;
    setReplayT(clockToMillis(meta.date, at));
  }, [meta]);

  // Replay keys: arrows step back/forward (Shift = 1 min), End or Escape returns to live. V switches view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (LOCKED || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      const head = liveSnap?.t;
      if (head === undefined) return;
      const step = e.shiftKey ? 60_000 : 5_000;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const from = replayT ?? head;
        const next = from + (e.key === "ArrowLeft" ? -step : step);
        const start = store.logRange?.start ?? head;
        setReplayT(next >= head ? undefined : Math.max(start, next));
      } else if (e.key === "End" || e.key === "Escape") {
        setReplayT(undefined);
      } else if (e.key === "v" || e.key === "V") {
        setView((v) => (v === "legacy" ? "penumbra" : "legacy"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [liveSnap?.t, replayT, store]);
  const bounds = useMemo(() => (meta ? boundsAround(meta.area.center, 10) : undefined), [meta]);
  const model = useMemo(() => {
    if (!snap) return undefined;
    const t0 = performance.now();
    const m = buildRenderModel(snap, store.lookupObs);
    stats.current.modelMs = performance.now() - t0;
    return m;
  }, [snap, store]);
  // Inspection hook for automated checks (screenshots, smoke tests).
  useEffect(() => {
    (window as unknown as { __penumbra?: unknown }).__penumbra = { snap, model, status, head: store.clock?.head, store, stats: stats.current, view, replayT };
  }, [snap, model, status, store, view, replayT]);
  useEffect(() => {
    const w = window as unknown as { __penumbra?: Record<string, unknown> };
    if (w.__penumbra)
      Object.assign(w.__penumbra, {
        selection,
        prov,
        cards,
        legacy,
        setReplayT,
        setView,
        recorder,
        caption,
        demoDone,
        // lon/lat -> page pixel, for automated clicks
        project: (lonLat: [number, number]) => {
          if (!viewState || !mapSize || !mapRef.current) return undefined;
          const [x, y] = new WebMercatorViewport({ ...viewState, ...mapSize }).project(lonLat);
          const r = mapRef.current.getBoundingClientRect();
          return [r.left + x!, r.top + y!];
        },
      });
  });

  // Label anchor for lost coverage: the lost cell nearest the centre, nudged into the lost area.
  // (A coarse raster is plenty for placing a label; the coverage itself is drawn as exact vectors.)
  const covKey = snap ? coverageKey(snap.coverage) : "";
  const lostLabel = useMemo(() => {
    if (!snap || !bounds || !meta) return undefined;
    const mask = computeCoverageMask(snap.coverage, bounds, 120, 120);
    let best: { lat: number; lon: number; d: number } | undefined;
    for (let r = 0; r < mask.rows; r++) {
      for (let c = 0; c < mask.cols; c++) {
        if (mask.cells[r * mask.cols + c] !== LOST) continue;
        const p = { lat: bounds.north - ((r + 0.5) / mask.rows) * (bounds.north - bounds.south), lon: bounds.west + ((c + 0.5) / mask.cols) * (bounds.east - bounds.west) };
        const d = distanceM(meta.area.center, p);
        if (!best || d < best.d) best = { ...p, d };
      }
    }
    if (!best) return undefined;
    const anchor = destination(best, bearingDeg(meta.area.center, best), 350);
    const lostSource = snap.sources.find((s) => mask.lostSources.includes(s.id));
    return {
      position: [anchor.lon, anchor.lat] as [number, number],
      head: `NO COVERAGE · SECTOR ${sectorName(meta.area.center, best)}`,
      sources: mask.lostSources.join(", "),
      since: lostSource?.statusSinceT ?? snap.t,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covKey, bounds, meta]);

  // Fit the airport (its layout says how far around the ARP, about 6 x 6 km) to the map pane.
  const initialViewState = useMemo(() => {
    if (!meta || !mapSize) return undefined;
    const km = boundsAround(meta.area.center, 1);
    const kmLon = (km.east - km.west) / 2;
    const kmLat = (km.north - km.south) / 2;
    const c = meta.area.center;
    const fitKm = layoutFor(meta.id).FIT_KM;
    const { width, height } = mapSize;
    const fit = new WebMercatorViewport({ width, height }).fitBounds(
      [
        [c.lon - fitKm.west * kmLon, c.lat - fitKm.south * kmLat],
        [c.lon + fitKm.east * kmLon, c.lat + fitKm.north * kmLat],
      ],
      { padding: Math.min(40, width / 20) },
    );
    return { longitude: fit.longitude, latitude: fit.latitude, zoom: fit.zoom, pitch: 0, bearing: 0 };
    // Fit once, when the pane first has a size; afterwards the operator owns the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, mapSize !== undefined]);

  const [viewState, setViewState] = useState<MapViewState>();
  useEffect(() => {
    if (initialViewState && !viewState) setViewState(initialViewState);
  }, [initialViewState, viewState]);

  // Declutter labels in screen space for the current view.
  const placement = useMemo(() => {
    if (!model || !viewState || !mapSize) return undefined;
    const vp = new WebMercatorViewport({ ...viewState, ...mapSize });
    const project = (p: [number, number]) => vp.project(p) as [number, number];
    const priority = { contradicted: 6, flagged: 5, corroborated: 4, degraded: 3, single: 3, ghost: 2, cooperative: 1 } as const;
    const items = model.glyphs.filter((g) => g.category !== "cooperative").map((g) => ({ id: g.id, position: g.position, lines: g.label, priority: priority[g.category] }));
    const flagBoxes = model.flags.map((f) => {
      const [x, y] = project(f.position);
      const w = Math.max(...f.label.map((l) => l.length)) * 7.9 + 16;
      return { x0: x - w / 2, y0: y - 34 - 44, x1: x + w / 2, y1: y - 30 };
    });
    return placeLabels(items, project, model.glyphs.map((g) => ({ position: g.position, radius: 22 })), flagBoxes, { width: vp.width, height: vp.height });
  }, [model, viewState, mapSize]);

  // LEGACY view model and its label placement.
  const legacy = useMemo(() => (snap && view === "legacy" ? buildLegacyModel(snap) : []), [snap, view]);
  const legacyPlacement = useMemo(() => {
    if (view !== "legacy" || !viewState || !mapSize) return undefined;
    const vp = new WebMercatorViewport({ ...viewState, ...mapSize });
    const project = (p: [number, number]) => vp.project(p) as [number, number];
    return placeLabels(
      legacy.map((t) => ({ id: t.id, position: t.position, lines: t.label, priority: 3 })),
      project,
      legacy.map((t) => ({ position: t.position, radius: 16 })),
      [],
      { width: vp.width, height: vp.height },
    );
  }, [legacy, view, viewState, mapSize]);

  // Timeline marks: the moments worth jumping back to.
  const marks = useMemo(
    () => timelineMarks(store.log, liveSnap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, liveSnap?.contradictions.length, liveSnap?.operatorActions.length, liveSnap?.flags.length, store],
  );

  // Selection: what the provenance panel shows. Until the operator picks something,
  // it follows the newest open contradiction's leading candidate (slide 7).
  const [userSel, setUserSel] = useState<Selection>();
  const select = useCallback(
    (sel: Selection, via: string) => {
      setUserSel(sel);
      recorder.log("select", { ...sel, via });
    },
    [recorder],
  );
  const selection = useMemo(() => (snap ? (reconcileSelection(userSel, snap) ?? defaultSelection(snap)) : undefined), [snap, userSel]);
  const lookups: Lookups = useMemo(() => ({ obs: store.lookupObs, verdict: store.lookupVerdict }), [store]);
  const cards = useMemo(() => (snap ? registerCards(snap, lookups) : []), [snap, lookups]);
  const sources = useMemo(() => (snap ? sourceRows(snap) : []), [snap]);
  const prov = useMemo(() => {
    if (!snap || !selection) return undefined;
    const p = provenance(selection, snap, lookups);
    // Decisions are only taken at the live head; a replay is for looking back.
    if (p && replayT !== undefined) p.action = { ...p.action, canResolve: false, canDefer: false, hint: "Replay: return to live (End) to act." };
    return p;
  }, [snap, selection, lookups, replayT]);
  const selectedGlyph = selection ? (selection.label ? `${selection.entityId}:${selection.label}` : selection.entityId) : undefined;

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" }>();
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const act = useCallback(
    async (kind: "resolve" | "defer") => {
      const a = prov?.action;
      if (!a?.dimension || busy) return;
      if (kind === "resolve" ? !a.canResolve : !a.canDefer) return;
      setBusy(true);
      recorder.log("action_request", { action: kind, contradictionId: a.contradictionId, entityId: a.entityId, dimension: a.dimension, value: a.resolveValue });
      const error = await store.act({
        operatorId: OPERATOR,
        action: kind,
        entityId: a.entityId,
        dimension: a.dimension,
        ...(kind === "resolve" && a.resolveValue ? { value: a.resolveValue } : {}),
      });
      setBusy(false);
      recorder.log("action_result", { action: kind, contradictionId: a.contradictionId, ok: !error, ...(error ? { error } : {}) });
      setToast(
        error
          ? { message: error, tone: "error" }
          : { message: `${a.contradictionId} ${kind === "resolve" ? `resolved as ${a.resolveValue?.replaceAll("-", " ")}` : "deferred"} · ${OPERATOR}`, tone: "ok" },
      );
    },
    [prov, busy, store, recorder],
  );

  // R resolves, D defers the selected item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (LOCKED || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      if (e.key === "r" || e.key === "R") void act("resolve");
      if (e.key === "d" || e.key === "D") void act("defer");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  // Keep the recorder's context current; record view switches and (debounced) replay moves.
  ctx.current = { simT: snap?.t, view, replay: replayT !== undefined, mode: ctx.current.mode };
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    recorder.log("view", { view });
  }, [view, recorder]);
  // Entering replay and returning to live are logged at once; scrubbing moves in between are debounced.
  const prevReplay = useRef<Millis | undefined>(undefined);
  useEffect(() => {
    const prev = prevReplay.current;
    prevReplay.current = replayT;
    if (replayT === undefined) {
      if (prev !== undefined) recorder.log("live");
      return;
    }
    if (prev === undefined) {
      recorder.log("replay", { at: new Date(replayT).toISOString() });
      return;
    }
    const id = setTimeout(() => recorder.log("replay_move", { at: new Date(replayT).toISOString() }), 400);
    return () => clearTimeout(id);
  }, [replayT, recorder]);
  useEffect(() => {
    if (status === "live") recorder.enableRemote();
  }, [status, recorder]);
  useEffect(() => {
    const flush = () => void recorder.flush();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [recorder]);

  // Probe: the runner receives map clicks while it is active.
  const probeClick = useRef<((c: ProbeClick) => void) | null>(null);
  const registerProbeClick = useCallback((fn: ((c: ProbeClick) => void) | null) => {
    probeClick.current = fn;
  }, []);

  // Demo director: cues fire as the live head passes them, then the epilogue after the end.
  const [caption, setCaption] = useState<string | null>();
  const [demoDone, setDemoDone] = useState(false);
  const applyCue = useCallback(
    (c: Cue) => {
      if (c.caption !== undefined) setCaption(c.caption);
      if (c.select) select(c.select, "demo");
      if (c.view) setView(c.view);
      if (c.replay === "live") setReplayT(undefined);
      else if (c.replay && meta) setReplayT(clockToMillis(meta.date, c.replay));
      if (c.end) setDemoDone(true);
      recorder.log("demo_cue", { at: c.at, ...(c.caption ? { caption: c.caption } : {}) });
    },
    [select, meta, recorder],
  );
  const lastHead = useRef<number>(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (!DEMO || !liveSnap || !meta) return;
    const prev = lastHead.current;
    lastHead.current = liveSnap.t;
    for (const c of cuesBetween(demoCuesFor(meta.id), prev, liveSnap.t, (clock) => clockToMillis(meta.date, clock))) applyCue(c);
  }, [liveSnap?.t, meta, applyCue]);
  const ended = store.clock?.ended ?? false;
  useEffect(() => {
    if (!DEMO || !ended) return;
    const timers = epilogue(demoCuesFor(meta?.id)).map((c) => setTimeout(() => applyCue(c), c.at.afterEndS * 1000));
    return () => timers.forEach(clearTimeout);
  }, [ended, applyCue, meta?.id]);

  // Three layer groups with different lifetimes, so a 10 Hz tick never re-tessellates static geometry.
  const zoomBucket = viewState ? Math.round(viewState.zoom * 4) / 4 : 13;
  const layout = useMemo(() => layoutFor(meta?.id), [meta?.id]);
  const staticLayers = useMemo(() => (bounds ? buildStaticLayers(bounds, zoomBucket, layout) : []), [bounds, zoomBucket, layout]);
  const sinceBucket = lostLabel && snap ? Math.floor((snap.t - lostLabel.since) / 1000) : 0;
  const coverageLayers = useMemo(() => {
    if (!snap || !bounds) return [];
    const label = lostLabel ? { position: lostLabel.position, lines: [lostLabel.head, `${lostLabel.sources} DOWN ${formatElapsed(sinceBucket)}`] } : undefined;
    return buildCoverageLayers(snap.coverage, bounds, zoomBucket, label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covKey, bounds, zoomBucket, lostLabel, sinceBucket]);
  const dynamicLayers = useMemo(() => {
    if (!model) return [];
    const t0 = performance.now();
    const out = buildDynamicLayers({
      model,
      ...(placement ? { placement } : {}),
      ...(hovered ? { hoveredId: hovered } : {}),
      ...(selectedGlyph ? { selectedId: selectedGlyph } : {}),
    });
    stats.current.layersMs = performance.now() - t0;
    return out;
  }, [model, placement, hovered, selectedGlyph]);
  const legacyLayers = useMemo(
    () => (view === "legacy" ? buildLegacyLayers(legacy, legacyPlacement, selection?.entityId) : []),
    [view, legacy, legacyPlacement, selection?.entityId],
  );
  // LEGACY draws no coverage, no uncertainty and no flags: only fused tracks on the basemap.
  const layers = useMemo(
    () => (view === "legacy" ? [...staticLayers, ...legacyLayers] : [...coverageLayers, ...staticLayers, ...dynamicLayers]),
    [view, coverageLayers, staticLayers, dynamicLayers, legacyLayers],
  );
  const head = liveSnap?.t;
  const logStart = store.logRange?.start;

  return (
    <div className="app">
      <Header
        store={store}
        status={status}
        operator={OPERATOR}
        health={snap?.feedHealth ?? []}
        frozen={FROZEN_AT !== undefined || LOCKED}
        locked={LOCKED}
        replay={replayT !== undefined && !PROBE}
        view={view}
        onView={setView}
        {...(snap ? { t: snap.t } : {})}
      />
      <div className="body">
      {view === "legacy" ? (
        <LegacyLeftPanel tracks={legacy} sources={snap?.sources ?? []} onSelect={(id) => select({ entityId: id }, "track-list")} {...(selection ? { selectedId: selection.entityId } : {})} />
      ) : (
        <LeftPanel cards={cards} sources={sources} onSelect={(sel) => select(sel, "register")} {...(selection ? { selection } : {})} />
      )}
      <div className="map" ref={mapRef}>
        {viewState && (
          <DeckGL
            views={MAP_VIEW}
            viewState={viewState}
            onViewStateChange={({ viewState: v }) => setViewState(v as MapViewState)}
            controller={{ dragRotate: false }}
            layers={layers}
            onHover={(info: PickingInfo) => setHovered((info.object as Glyph | undefined)?.entityId)}
            onClick={(info: PickingInfo) => {
              const o = info.object as Glyph | LegacyTrack | undefined;
              if (PROBE && probeClick.current) {
                const contact = o && "entityId" in o ? o.entityId : o && "trackQuality" in o ? o.id : undefined;
                const c = info.coordinate as [number, number] | undefined;
                probeClick.current({ ...(contact ? { contact } : {}), ...(c ? { location: { lon: c[0], lat: c[1] } } : {}) });
                return;
              }
              if (o && "entityId" in o) select({ entityId: o.entityId, ...(o.kind === "candidate" ? { label: o.id.split(":")[1]! } : {}) }, "map");
              else if (o && "trackQuality" in o) select({ entityId: o.id }, "map");
            }}
            getCursor={({ isHovering }) => (isHovering ? "pointer" : "grab")}
            getTooltip={(info: PickingInfo) => tooltip(info, snap, view)}
          />
        )}
        {view === "penumbra" && <Legend />}
        {view === "legacy" && <div className="legacy-banner">LEGACY VIEW · SAME DATA AS A FIELDED COP</div>}
        <Banner credit={layout.credit} />
        {replayT !== undefined && head !== undefined && snap && !LOCKED && <ReplayBanner t={snap.t} head={head} onLive={() => setReplayT(undefined)} />}
        {head !== undefined && logStart !== undefined && snap && !PROBE && (
          <Timeline
            logStart={logStart}
            head={head}
            t={snap.t}
            replaying={replayT !== undefined}
            marks={marks}
            window={tlWindow}
            onWindow={setTlWindow}
            onScrub={(t) => setReplayT(t)}
            onLive={() => setReplayT(undefined)}
          />
        )}
        {SHOW_STATS && <Stats stats={stats.current} entities={snap?.entities.length ?? 0} />}
        {!PROBE && <Toast tone={toast?.tone ?? "ok"} {...(toast ? { message: toast.message } : {})} />}
        {DEMO && <Caption text={caption} />}
        {PROBE && meta && (
          <ProbeRunner
            date={meta.date}
            scenario={meta.id}
            arp={meta.area.center}
            recorder={recorder}
            snapshotAt={(t) => store.snapshotAt(t)}
            setView={setView}
            setReplay={setReplayT}
            registerClick={registerProbeClick}
          />
        )}
      </div>
      {view === "legacy" ? (
        <LegacyRightPanel marking={MARKING} {...((t) => (t ? { track: t } : {}))(legacy.find((t) => t.id === selection?.entityId))} />
      ) : (
        <RightPanel marking={MARKING} busy={busy} onResolve={() => void act("resolve")} onDefer={() => void act("defer")} {...(prov ? { view: prov } : {})} />
      )}
      </div>
    </div>
  );
}

function tooltip(info: PickingInfo, snap: PictureSnapshot | undefined, view: ViewMode) {
  const o = info.object as Glyph | FlagMarker | LegacyTrack | undefined;
  if (!o || !snap) return null;
  const style = { background: "rgba(8,12,26,0.95)", border: "1px solid #1e2748", color: "#dfe6f3", padding: "8px 10px" };
  if ("trackQuality" in o) return view === "legacy" ? { html: `<div class="tooltip"><b>${o.id}</b> · ${o.label[1]}<br/>TQ ${o.trackQuality}/15</div>`, style } : null;
  if ("spokes" in o) return { html: `<div class="tooltip">${o.label.join("<br/>")}<br/>flags only; confidence counts the burst as one vote</div>`, style };
  const entityId = o.entityId;
  const e = snap.entities.find((x) => x.id === entityId);
  if (!e) return null;
  const rows = e.confidence.contributions
    .slice(0, 5)
    .map((c) => `${c.originId.padEnd(13, " ")} ${c.sourceType.padEnd(8, " ")} +${c.contribution.toFixed(2)}`)
    .join("<br/>");
  return {
    html: `<div class="tooltip"><b>${e.id}</b> · ${e.entityClass} · ${e.state.toUpperCase()}<br/>confidence ${e.confidence.value.toFixed(2)} from ${e.sourceCount} source(s)<br/>${rows}</div>`,
    style,
  };
}
