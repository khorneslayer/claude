export function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="sw corroborated" />
        CORROBORATED
      </span>
      <span>
        <i className="sw contradicted" />
        CONTRADICTED
      </span>
      <span>
        <i className="sw ghost" />
        AGED / GHOST
      </span>
      <span>
        <i className="sw blind" />
        NO COVERAGE
      </span>
    </div>
  );
}

export function Banner({ credit }: { credit: string }) {
  return (
    <div className="banner">
      <b>EXERCISE · SYNTHETIC DATA</b>
      <br />
      {credit}
      <br />
      NOT FOR NAVIGATION
    </div>
  );
}
