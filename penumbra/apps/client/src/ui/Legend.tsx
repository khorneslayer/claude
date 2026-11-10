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

export function Banner() {
  return (
    <div className="banner">
      <b>EXERCISE · SYNTHETIC DATA</b>
      <br />
      LAYOUT © R. AEHNELT · WIKIMEDIA (CC)
      <br />
      NOT FOR NAVIGATION
    </div>
  );
}
