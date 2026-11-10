import { MapView, WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import DeckGL from "@deck.gl/react";
import { formatElapsed, type PictureSnapshot } from "@penumbra/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { connectLive } from "./feed/live";
import { startOffline } from "./feed/offline";
import { FeedStore } from "./feed/store";
import { buildCoverageLayers, buildDynamicLayers, buildStaticLayers } from "./map/layers";
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

/**
 * URL parameters
 *   ?mode=offline        play the scenario in the browser (no server)
 *   ?t=14:41:22          offline, frozen at that moment (screenshots, briefings)
 *   ?speed=4             initial playback speed
 *   ?ws=ws://host/ws     feed URL (default: same origin /ws, proxied to the server in dev)
 *   ?evalHz=10           local re-evaluation rate
 *   ?stress=500          offline, plus N synthetic three-source drones (performance check)
 *   ?stats               fps meter and per-tick timings
 *   ?op=OP-3             operator id for RESOLVE / DEFER (default OP-1)
 *   ?scripted            offline: keep the scenario's scripted decisions after playFrom
 */
const params = new URLSearchParams(window.location.search);
const FROZEN_AT = params.get("t") ?? undefined;
const EVAL_HZ = Number(params.get("evalHz") ?? 10);
const MAP_VIEW = new MapView({ repeat: false });
const STRESS = params.get("stress") ? Number(params.get("stress")) : undefined;
const SHOW_STATS = params.has("stats");
const OPERATOR = params.get("op") ?? "OP-1";
const SCRIPTED = params.has("scripted");
/** Mock releasability marking (slide 6, item 08): visible without opening a dialogue. */
const MARKING = "EXERCISE · SYNTHETIC DATA · REL DEU/NLD (MOCK)";

export function App() {
  const store = useMemo(() => new FeedStore(), []);
  const status = useSyncExternalStore(store.subscribe, () => store.status);
  const [snap, setSnap] = useState<PictureSnapshot>();
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
    const offline = () =>
      startOffline(store, {
        ...(FROZEN_AT ? { at: FROZEN_AT, paused: true } : {}),
        ...(speed ? { speed } : {}),
        ...(STRESS ? { stress: STRESS } : {}),
        scripted: SCRIPTED,
      });
    if (FROZEN_AT || STRESS || params.get("mode") === "offline") {
      offline();
      return;
    }
    const url = params.get("ws") ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
    void connectLive(store, url).then((ok) => {
      if (!ok) offline();
      else if (speed) store.control("speed", speed);
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
      setSnap(next);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  // Space toggles play / pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !FROZEN_AT && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        store.control(store.clock?.playing ? "pause" : "play");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const meta = store.meta;
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
    (window as unknown as { __penumbra?: unknown }).__penumbra = { snap, model, status, head: store.clock?.head, store, stats: stats.current };
  }, [snap, model, status, store]);
  useEffect(() => {
    const w = window as unknown as { __penumbra?: Record<string, unknown> };
    if (w.__penumbra) Object.assign(w.__penumbra, { selection, prov, cards });
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
    const anchor = destination(best, bearingDeg(meta.area.center, best), 900);
    const lostSource = snap.sources.find((s) => mask.lostSources.includes(s.id));
    return {
      position: [anchor.lon, anchor.lat] as [number, number],
      head: `NO COVERAGE · SECTOR ${sectorName(meta.area.center, best)}`,
      sources: mask.lostSources.join(", "),
      since: lostSource?.statusSinceT ?? snap.t,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covKey, bounds, meta]);

  // Fit the operating area (about 12 x 8 km around the scenario centre) to the map pane.
  const initialViewState = useMemo(() => {
    if (!meta || !mapSize) return undefined;
    const km = boundsAround(meta.area.center, 1);
    const kmLon = (km.east - km.west) / 2;
    const kmLat = (km.north - km.south) / 2;
    const c = meta.area.center;
    const { width, height } = mapSize;
    const fit = new WebMercatorViewport({ width, height }).fitBounds(
      [
        [c.lon - 5.6 * kmLon, c.lat - 4.4 * kmLat],
        [c.lon + 5.4 * kmLon, c.lat + 3.2 * kmLat],
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

  // Selection: what the provenance panel shows. Until the operator picks something,
  // it follows the newest open contradiction's leading candidate (slide 7).
  const [userSel, setUserSel] = useState<Selection>();
  const selection = useMemo(() => (snap ? (reconcileSelection(userSel, snap) ?? defaultSelection(snap)) : undefined), [snap, userSel]);
  const lookups: Lookups = useMemo(() => ({ obs: store.lookupObs, verdict: store.lookupVerdict }), [store]);
  const cards = useMemo(() => (snap ? registerCards(snap, lookups) : []), [snap, lookups]);
  const sources = useMemo(() => (snap ? sourceRows(snap) : []), [snap]);
  const prov = useMemo(() => (snap && selection ? provenance(selection, snap, lookups) : undefined), [snap, selection, lookups]);
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
      const error = await store.act({
        operatorId: OPERATOR,
        action: kind,
        entityId: a.entityId,
        dimension: a.dimension,
        ...(kind === "resolve" && a.resolveValue ? { value: a.resolveValue } : {}),
      });
      setBusy(false);
      setToast(
        error
          ? { message: error, tone: "error" }
          : { message: `${a.contradictionId} ${kind === "resolve" ? `resolved as ${a.resolveValue?.replaceAll("-", " ")}` : "deferred"} · ${OPERATOR}`, tone: "ok" },
      );
    },
    [prov, busy, store],
  );

  // R resolves, D defers the selected item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      if (e.key === "r" || e.key === "R") void act("resolve");
      if (e.key === "d" || e.key === "D") void act("defer");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  // Three layer groups with different lifetimes, so a 10 Hz tick never re-tessellates static geometry.
  const staticLayers = useMemo(() => (bounds ? buildStaticLayers(bounds) : []), [bounds]);
  const zoomBucket = viewState ? Math.round(viewState.zoom * 4) / 4 : 13;
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
  const layers = useMemo(() => [...coverageLayers, ...staticLayers, ...dynamicLayers], [coverageLayers, staticLayers, dynamicLayers]);

  return (
    <div className="app">
      <Header store={store} status={status} operator={OPERATOR} health={snap?.feedHealth ?? []} frozen={FROZEN_AT !== undefined} {...(snap ? { t: snap.t } : {})} />
      <div className="body">
      <LeftPanel cards={cards} sources={sources} onSelect={setUserSel} {...(selection ? { selection } : {})} />
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
              const g = info.object as Glyph | undefined;
              if (g && "entityId" in g) setUserSel({ entityId: g.entityId, ...(g.kind === "candidate" ? { label: g.id.split(":")[1]! } : {}) });
            }}
            getCursor={({ isHovering }) => (isHovering ? "pointer" : "grab")}
            getTooltip={(info: PickingInfo) => tooltip(info, snap)}
          />
        )}
        <Legend />
        <Banner />
        {SHOW_STATS && <Stats stats={stats.current} entities={snap?.entities.length ?? 0} />}
        <Toast tone={toast?.tone ?? "ok"} {...(toast ? { message: toast.message } : {})} />
      </div>
      <RightPanel marking={MARKING} busy={busy} onResolve={() => void act("resolve")} onDefer={() => void act("defer")} {...(prov ? { view: prov } : {})} />
      </div>
    </div>
  );
}

function tooltip(info: PickingInfo, snap: PictureSnapshot | undefined) {
  const o = info.object as Glyph | FlagMarker | undefined;
  if (!o || !snap) return null;
  const style = { background: "rgba(8,12,26,0.95)", border: "1px solid #1e2748", color: "#dfe6f3", padding: "8px 10px" };
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
