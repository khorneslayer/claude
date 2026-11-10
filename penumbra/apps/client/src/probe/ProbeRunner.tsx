import { clockToMillis, type LatLon, type PictureSnapshot } from "@penumbra/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRecorder } from "../session/recorder";
import { blindPoint, expected, QUESTIONS, score, summarise, trialsFor, type Answer, type ProbeResult, type ProbeView, type Trial } from "./trials";

export interface ProbeClick {
  contact?: string;
  location?: LatLon;
}

type Phase = { kind: "intro" } | { kind: "ready"; i: number } | { kind: "showing"; i: number; shownAt: number } | { kind: "done" };

const VIEW_NAME: Record<ProbeView, string> = { penumbra: "PENUMBRA", legacy: "LEGACY" };

/**
 * Runs the legibility probe over the live app: sets the view and the frozen
 * moment for each trial, times the answer from the moment the frame is on
 * screen, scores it against the engine's picture and records everything.
 */
export function ProbeRunner(props: {
  date: string;
  /** Scenario id, logged with every answer so BER and KMRB results stay apart. */
  scenario: string;
  arp: LatLon;
  recorder: SessionRecorder;
  snapshotAt: (t: number) => PictureSnapshot;
  setView: (v: ProbeView) => void;
  setReplay: (t: number | undefined) => void;
  registerClick: (fn: ((c: ProbeClick) => void) | null) => void;
}) {
  const { date, scenario, arp, recorder, snapshotAt, setView, setReplay, registerClick } = props;
  const [participant, setParticipant] = useState(() => `P-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [hint, setHint] = useState<string>();
  const trials = useMemo(() => trialsFor(participant), [participant]);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const showTrial = useCallback(
    (i: number) => {
      const t = trials[i]!;
      setView(t.view);
      setReplay(clockToMillis(date, t.at));
      setHint(undefined);
      // Start the clock once the frame has actually been painted.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setPhase({ kind: "showing", i, shownAt: performance.now() });
          // Automation hook (probe smoke test): the trial on screen and a valid answer for it.
          const snap = snapshotAt(clockToMillis(date, t.at));
          (window as unknown as { __probe?: unknown }).__probe = {
            trial: t,
            expected: expected(t.question, snap, t.view, arp),
            blindPoint: blindPoint(snap, arp),
          };
          recorder.log("probe_trial_shown", { participant, trial: t.id, index: i, view: t.view, at: t.at, question: t.question });
        }),
      );
    },
    [trials, date, setView, setReplay, recorder, participant, snapshotAt, arp],
  );

  const answer = useCallback(
    (a: Answer) => {
      const ph = phaseRef.current;
      if (ph.kind !== "showing") return;
      const t: Trial = trials[ph.i]!;
      const q = QUESTIONS[t.question];
      if (!a.skipped && q.answer === "contact" && !a.contact) return setHint("Click a contact on the map.");
      if (!a.skipped && q.answer === "location" && !a.location) return setHint("Click a point on the map.");
      const latencyMs = Math.round(performance.now() - ph.shownAt);
      const snap = snapshotAt(clockToMillis(date, t.at));
      const correct = score(t.question, a, snap, t.view, arp);
      const exp = expected(t.question, snap, t.view, arp).note;
      const r: ProbeResult = { trial: t, correct, latencyMs, answer: a, expected: exp };
      recorder.log("probe_answer", { participant, scenario, trial: t.id, index: t.index, view: t.view, at: t.at, question: t.question, answer: a, correct, latencyMs, expected: exp });
      setResults((rs) => [...rs, r]);
      const next = ph.i + 1;
      if (next < trials.length) setPhase({ kind: "ready", i: next });
      else {
        setPhase({ kind: "done" });
        setReplay(undefined);
        setView("penumbra");
      }
    },
    [trials, snapshotAt, date, scenario, arp, recorder, participant, setReplay, setView],
  );

  useEffect(() => {
    registerClick((c) => answer(c.contact ? { contact: c.contact } : c.location ? { location: c.location } : {}));
    return () => registerClick(null);
  }, [registerClick, answer]);

  useEffect(() => {
    if (phase.kind === "done") {
      const s = summarise(results);
      recorder.log("probe_done", { participant, summary: s });
      void recorder.flush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  if (phase.kind === "intro") {
    return (
      <div className="probe-modal" role="dialog" aria-label="Legibility probe">
        <h2>Legibility probe</h2>
        <p>Six short questions about the picture, three in each of two views. Answer each by clicking on the map, as quickly as you can while being sure. Synthetic exercise data.</p>
        <label>
          Participant id
          <input value={participant} onChange={(e) => setParticipant(e.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "P")} />
        </label>
        <button
          className="primary"
          onClick={() => {
            recorder.log("probe_start", { participant, trials: trials.map((t) => ({ id: t.id, view: t.view, at: t.at })) });
            setPhase({ kind: "ready", i: 0 });
          }}
        >
          Start
        </button>
      </div>
    );
  }
  if (phase.kind === "ready") {
    const t = trials[phase.i]!;
    return (
      <div className="probe-modal" role="dialog" aria-label={`Trial ${phase.i + 1}`}>
        <div className="probe-step">
          Trial {phase.i + 1} of {trials.length} · {VIEW_NAME[t.view]} view
        </div>
        <h2>{QUESTIONS[t.question].prompt}</h2>
        <button className="primary" onClick={() => showTrial(phase.i)} autoFocus>
          Show the picture
        </button>
      </div>
    );
  }
  if (phase.kind === "showing") {
    const t = trials[phase.i]!;
    return (
      <div className="probe-bar" role="status">
        <span className="probe-step">
          {phase.i + 1}/{trials.length} · {VIEW_NAME[t.view]}
        </span>
        <b>{QUESTIONS[t.question].prompt}</b>
        {hint && <span className="probe-hint">{hint}</span>}
        <button onClick={() => answer({ skipped: true })}>Can’t tell</button>
      </div>
    );
  }
  const s = summarise(results);
  return (
    <div className="probe-modal" role="dialog" aria-label="Probe results">
      <h2>Thank you</h2>
      <table className="probe-summary">
        <thead>
          <tr>
            <th>View</th>
            <th>Correct</th>
            <th>Median time</th>
          </tr>
        </thead>
        <tbody>
          {(["penumbra", "legacy"] as ProbeView[]).map((v) => (
            <tr key={v}>
              <td>{VIEW_NAME[v]}</td>
              <td>
                {s[v].correct} / {s[v].n}
              </td>
              <td>{(s[v].medianMs / 1000).toFixed(1)} s</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="probe-note">Session {recorder.id}. Results are in the session log.</p>
      <button className="primary" onClick={() => recorder.download()}>
        Download session log
      </button>
    </div>
  );
}
