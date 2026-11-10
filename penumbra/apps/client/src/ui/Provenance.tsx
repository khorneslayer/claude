import type { ProvenanceView } from "../model/panels";

const TONE: Record<string, string> = { RF: "cyan", EO: "cyan", ADSB: "cyan", RADAR: "cyan", REMOTE_ID: "cyan", CIV_CALL: "amber", SOCIAL: "orange", OPERATOR: "white" };

export function RightPanel(props: {
  view?: ProvenanceView;
  marking: string;
  busy: boolean;
  onResolve: () => void;
  onDefer: () => void;
}) {
  const { view, marking, busy, onResolve, onDefer } = props;
  return (
    <aside className="panel right" aria-label="Provenance">
      {!view ? (
        <p className="empty">Select a contact or a contradiction.</p>
      ) : (
        <>
          <h2 className="panel-title cyan">Provenance · {view.title}</h2>
          <div className="subtitle">{view.subtitle}</div>
          <div className="big">
            <span className="big-value">{view.value.toFixed(2)}</span>
            <span className="big-note">
              computed
              <br />
              not stored
              {view.status && view.status !== "open" && <b className={`status ${view.status}`}>{view.status}</b>}
            </span>
          </div>
          <ul className="contribs">
            {view.rows.length === 0 && <li className="empty">No standing evidence.</li>}
            {view.rows.map((r) => (
              <li key={r.key} className={`contrib ${TONE[r.tone] ?? "grey"}`} title={r.factors}>
                <div className="contrib-head">{r.heading}</div>
                <div className="contrib-body">
                  {r.description} Contributes <b>+{r.contribution.toFixed(2)}</b>
                </div>
                {r.quote && <div className="contrib-quote">“{r.quote}”</div>}
                <div className="contrib-factors">{r.factors}</div>
              </li>
            ))}
          </ul>
          <h2 className="panel-title cyan">Chain</h2>
          <div className="chain">{view.chain.join(" → ")}</div>
        </>
      )}
      <div className="panel-foot">
        <div className="marking">{marking}</div>
        {view?.action.hint && <div className="hint">{view.action.hint}</div>}
        <div className="actions">
          <button className="resolve" disabled={busy || !view?.action.canResolve} onClick={onResolve} title="Resolve (R)">
            {view?.action.resolveValue ? `Resolve · ${view.action.resolveValue.replaceAll("-", " ")}` : "Resolve"}
          </button>
          <button className="defer" disabled={busy || !view?.action.canDefer} onClick={onDefer} title="Defer (D)">
            Defer
          </button>
        </div>
      </div>
    </aside>
  );
}

export function Toast({ message, tone }: { message?: string; tone: "ok" | "error" }) {
  if (!message) return null;
  return (
    <div className={`toast ${tone}`} role="status">
      {message}
    </div>
  );
}
