import type { RegisterCard, Selection, SourceRow } from "../model/panels";

export function LeftPanel(props: { cards: RegisterCard[]; sources: SourceRow[]; selection?: Selection; onSelect: (s: Selection) => void }) {
  const { cards, sources, selection, onSelect } = props;
  return (
    <aside className="panel left" aria-label="Contradiction register and source reliability">
      <h2 className="panel-title alert">Contradiction register</h2>
      {cards.length === 0 && <p className="empty">No contradictions on the picture.</p>}
      <ul className="cards">
        {cards.map((c) => {
          const selected = selection?.entityId === c.entityId;
          return (
            <li key={c.id}>
              <button className={`card ${c.tone}${selected ? " selected" : ""}`} onClick={() => onSelect(c.select)} aria-pressed={selected}>
                <div className="card-head">
                  {c.id} · {c.statusText}
                </div>
                <div className="card-body">{c.summary}</div>
                <div className="card-hyps">
                  {c.hypotheses.map((h) => (
                    <span key={h.value} className={`hyp ${h.status}`}>
                      {h.label ? `${h.label.replace("CAND-", "")} ` : ""}
                      {h.confidence.toFixed(2)}
                    </span>
                  ))}
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      <h2 className="panel-title">Source reliability</h2>
      <ul className="sources">
        {sources.map((s) => (
          <li key={s.id} className={`source ${s.tone}`}>
            <div className="source-line">
              <span className="source-name">{s.label}</span>
              <span className="source-value">{s.reliability.toFixed(2)}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round(s.reliability * 100)}%` }} />
            </div>
            {s.note && <div className="source-note">{s.note}</div>}
          </li>
        ))}
      </ul>
    </aside>
  );
}
