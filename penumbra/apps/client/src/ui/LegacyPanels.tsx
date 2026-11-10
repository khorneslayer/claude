import { formatClock, type SourceView } from "@penumbra/core";
import type { LegacyTrack } from "../model/legacy";
import { age } from "../model/view";

export function LegacyLeftPanel(props: { tracks: LegacyTrack[]; sources: SourceView[]; selectedId?: string; onSelect: (id: string) => void }) {
  const { tracks, sources, selectedId, onSelect } = props;
  return (
    <aside className="panel left legacy" aria-label="Track list and sensor status">
      <h2 className="panel-title plain">Track list</h2>
      <table className="tracks">
        <thead>
          <tr>
            <th>Track</th>
            <th>Class</th>
            <th>Upd</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t) => (
            <tr key={t.id} className={t.id === selectedId ? "selected" : ""} onClick={() => onSelect(t.id)}>
              <td>{t.id}</td>
              <td>{t.label[1]!.split(" · ").slice(0, 2).join(" · ")}</td>
              <td>{age(t.ageS)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="panel-title plain">Sensor status</h2>
      <ul className="sensor-status">
        {sources
          .filter((s) => s.type !== "OPERATOR")
          .map((s) => (
            <li key={s.id} className={s.status}>
              <span>{s.label}</span>
              <span>{s.status.toUpperCase()}</span>
            </li>
          ))}
      </ul>
    </aside>
  );
}

export function LegacyRightPanel({ track, marking }: { track?: LegacyTrack; marking: string }) {
  return (
    <aside className="panel right legacy" aria-label="Track details">
      {!track ? (
        <p className="empty">Select a track.</p>
      ) : (
        <>
          <h2 className="panel-title plain">Track details · {track.id}</h2>
          <dl className="details">
            <dt>Classification</dt>
            <dd>{track.label[1]}</dd>
            <dt>Position</dt>
            <dd>
              {track.latLon.lat.toFixed(4)} N {track.latLon.lon.toFixed(4)} E
            </dd>
            {track.altM !== undefined && (
              <>
                <dt>Altitude</dt>
                <dd>{track.altM} m</dd>
              </>
            )}
            <dt>Last update</dt>
            <dd>{formatClock(track.lastUpdateT)}</dd>
            <dt>Track quality</dt>
            <dd>{track.trackQuality} / 15</dd>
          </dl>
        </>
      )}
      <div className="panel-foot">
        <div className="marking">{marking}</div>
        <div className="hint">LEGACY VIEW: the same data drawn the way fielded systems draw it. Press V to switch back.</div>
      </div>
    </aside>
  );
}
