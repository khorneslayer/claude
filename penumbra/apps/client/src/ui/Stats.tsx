import { useEffect, useState } from "react";

/** fps meter + per-tick timings, for the "60 fps with 500 entities" check on real hardware (?stats). */
export function Stats({ stats, entities }: { stats: { evalMs: number; modelMs: number; layersMs: number }; entities: number }) {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let raf = 0;
    let t0 = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - t0 >= 1000) {
        setFps(Math.round((frames * 1000) / (now - t0)));
        frames = 0;
        t0 = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div style={{ position: "absolute", top: 12, right: 12, padding: "8px 12px", background: "rgba(8,12,26,0.9)", border: "1px solid var(--line)", fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ color: fps >= 55 ? "var(--neutral)" : fps >= 30 ? "var(--amber)" : "var(--orange)" }}>{fps} fps</div>
      <div>{entities} entities</div>
      <div style={{ color: "var(--dim)" }}>
        eval {stats.evalMs.toFixed(1)} · model {stats.modelMs.toFixed(1)} · layers {stats.layersMs.toFixed(1)} ms
      </div>
    </div>
  );
}
