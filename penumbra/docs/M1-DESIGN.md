# PENUMBRA Phase 0 · M1 design and review notes

M1 scope from the [prototype brief](../PHASE0_PROTOTYPE_BRIEF.md): data model, confidence engine, scenario engine, WebSocket stream, tests. No UI.

This document is the review gate. It covers the observation schema, the confidence maths, and every decision that goes beyond the brief or interprets it. Items marked **REVIEW** need a decision before M2.

---

## 1. What exists

```
scenarios/ber-south-uas-surge.yaml   designer-editable scenario (timed beats)
        │  parseScenario / validateScenario      packages/sim
        ▼
compileScenario(def, seed)  ──►  ordered LogEvent[]  (deterministic, seeded)
        │
        ▼                                         apps/server
PenumbraServer: publishes events as the sim clock passes them, appends
operator actions at the head, keeps a live Projector
        │  WebSocket /ws  (hello · events · snapshot · clock · ack · error)
        ▼
client (M2) ── or ── pnpm frame (text rendering of any moment)

packages/core: types · EventLog (append-only) · Projector / project(log, t) · confidence maths · geo · seeded RNG
```

The one function that matters is `project(log, t)`. It is pure: the picture at time `t` from the log alone. Events after `t` are ignored, so a past picture can always be rebuilt exactly. `Projector` is the same computation, done incrementally for the live head. A property test checks that the two always agree.

## 2. Observation schema (the log)

Every event has `seq` (strictly increasing, assigned by the log) and `t` (simulation time, epoch ms UTC). The log is append-only and refuses events that go back in time.

| kind | purpose | key fields |
|---|---|---|
| `config` | projection tuning, carried in the log so a replay needs nothing else | thresholds, entity classes, deception parameters |
| `source_registered` | a sensor or report channel | `sourceType`, Beta `prior {alpha, beta}`, `halfLifeS`, `footprint` polygon (with holes), `coverageLayers` |
| `source_status` | up / degraded / down | `status`, `note` |
| `observation` | one report about one contact | `sourceId` (reliability bucket), `originId` (independence unit), `entityId`, `position {lat, lon, altM, sigmaM}`, optional raw `bearing`, `quality` ∈ [0,1], `claims` (e.g. `{intent: "hobbyist"}`), `extraction` (sensor/human/ai), `chain`, `text` |
| `verification` | ground truth on one observation | `obsId`, `confirmed` / `falsified`, `by` |
| `operator_action` | resolve / defer a contradiction | `operatorId`, `entityId`, `dimension`, `value` |

Design points:
- **`sourceId` vs `originId`.** The source decides whose track record weights a report. The origin decides what counts as independent. An RF sensor's 100 fixes are one origin and corroborate nothing. Three civilian callers on the same call line are three origins, sharing the line's reliability.
- **`claims` are discrete, per dimension.** A report that doesn't mention a dimension is *neutral* on it, consistent with every value. That is how "a drone near the south entrance" supports both CAND-A and CAND-B.
- **Correlation is scripted in Phase 0** (`correlation: "scripted"`). The field exists so a real correlator can be named later.
- **Standards.** The observation fields are what a sensor detection report carries: position with uncertainty, bearing, classification with confidence, timestamps, source identity. A SAPIENT or Cursor-on-Target adapter should be a thin field mapping. **Nothing is implemented, and the mapping still needs checking against the actual specs.**

## 3. Confidence maths

For each observation *i* from source *s*, at read time *t*:

```
reliability   r_s  = alpha / (alpha + beta)          Beta posterior, updated by verdicts
decay         d_i  = 2^(-(t - t_i) / halfLife_s)
weight        w_i  = r_s · q_i · d_i                  (capped at 0.999)

per origin    W_o  = max_i w_i                         an origin gets one vote: its strongest report
confidence    C    = 1 − Π_o (1 − W_o)                 noisy-OR over independent origins
share         c_o  = C · m_o / Σ m,   m_o = −ln(1 − W_o)
```

**Why noisy-OR.** Each independent origin is a separate chance that the contact is real. One weak report gives low confidence, and agreeing independent reports compound. It is bounded below 1 and never decreases when evidence is added (property-tested).

**Why this decomposition.** The brief requires the provenance contributions to sum to the displayed confidence. Noisy-OR is not additive, so each origin gets a share proportional to its *evidential mass*, −ln(1 − W). The shares sum exactly to C, don't depend on order, and give stronger evidence a bigger share. The UI rounds with largest-remainder rounding (`roundPreservingSum`), so the on-screen figures still add up.

**Worked example: slide 7, CAND-A at 14:41:22Z**

| origin | r | q | age | decay | w | share |
|---|---|---|---|---|---|---|
| RF-SENSE-N | 0.91 | 0.57 | 138 s (half-life 300) | 0.73 | 0.38 | **+0.34** |
| CALLER-2 | 0.42 | 0.47 | 271 s (half-life 600) | 0.73 | 0.14 | **+0.11** |
| SOC-ACCT-118 | 0.17 | 0.81 | 670 s (half-life 900) | 0.60 | 0.08 | **+0.06** |
| | | | | | C = 1 − (0.62 · 0.86 · 0.92) | **0.51** |

Run `pnpm frame` to print this panel from the live engine.

**Verdicts.** A falsified report drops out entirely and adds 1 to its source's beta. A confirmed report counts at reliability 1 and adds 1 to alpha. Reliability is read at evaluation time, so one falsified social post lowers the weight of every post from that source still on the picture. The scenario shows this: SOCIAL SCRAPE drops from 0.18 to 0.17 when police falsify the stadium post.

**Performance.** Within one origin all reports decay at the same rate under the same reliability, so their ranking never changes over time. The `Projector` keeps each origin's strongest report as events arrive, and a read costs one weight per origin rather than per report. Only a verdict forces a rescan of the affected groups.

## 4. Hypotheses and contradictions

- A **hypothesis** is one value on one dimension of one contact. Its confidence is the noisy-OR over the reports *consistent* with it: those asserting it, plus those neutral on the dimension. Competing hypotheses each keep their own breakdown and are never averaged.
- A **contradiction opens** the first time two values on the same dimension both have live support (some origin's weight ≥ `activeWeightEpsilon`, 0.05). Its ID (`CTR-nnn`) is assigned in order of opening and is stable.
- **CAND labels are scoped to their contradiction.** At opening, CAND-A goes to the leading hypothesis, and values that join later take the next letter. This is what puts the RF "hobbyist" reading at CAND-A even though the civilian "coordinated pair" call came first.
- **Status:** `unresolved` → `deferred` / `resolved` from operator actions. **`lapsed`** is new (not in the brief). It applies when support for all but one value has decayed, so the conflict isn't live any more, even though nobody resolved it.
- **DECIDED: a resolution is evidence** (`operator.resolutionIsEvidence`, on by default). When an operator resolves a contradiction:
  1. their judgement enters as a report from the virtual `OPERATOR` source (origin = the operator, reliability Beta(8, 2) = 0.8, half-life 30 min), asserting the accepted value. It is a visible row in provenance.
  2. reports that asserted a rejected value *before* the decision still say something is there, so they now count for the accepted reading.
  3. rejected hypotheses go to `status: "rejected"` with confidence 0.
  4. if fresh, live evidence for a rejected value arrives *after* the decision, the contradiction **reopens** (`reopened: true`, back to unresolved) instead of being silently overruled. A new resolution settles it again. "Fresh" means from an origin that had not asserted that value before the decision: a source repeating the reading the operator overruled (a camera classifier saying "bird" every 2 s) does not reopen it.

  A deferral changes nothing. Consequence to watch: in the scenario the operator becomes CAND-A's largest contributor (+0.56 of 0.93). That's the echo effect, and it's tuned by the operator reliability. Switching the flag off restores record-only resolutions (tested).

## 5. Ghosts and the uncertainty envelope

Once a contact's last positional fix is older than its class's `ghostAfterS`, it becomes a **ghost**. Two radii are reported:

- `envelopeRadiusM`: where it plausibly is now. A correlated random walk (Ornstein–Uhlenbeck velocity) at cruise speed, with exact variance `2v²τ(t − τ(1 − e^(−t/τ)))`.
- `maxReachM`: where it could physically be. Max speed × min(age, endurance), which is the brief's "kinematic bound capped by endurance".

**DECIDED:** M2 draws the plausible envelope as the ghost's area and the hard kinematic bound as a faint outer ring. (The brief's bound alone is 41.5 km for a drone lost 41 minutes ago, which fills the map. The random-walk envelope gives 2.4 km, matching slide 7.)

A ghost stays on the picture for `retainGhostS` after its last fix, even once its confidence has decayed to near zero. The snapshot also reports `confidenceAtLastFix` (0.51 for TRK-1152), so the label can read "last conf 41m".

## 6. Deception flags

A flag is raised when at least `minReports` (6) **distinct origins** from sources below `lowReliabilityBelow` (0.5) arrive within `burstSpanS` (60 s), all within `radiusM` (3 km) of their centroid. Reports that have already been verified are excluded. A flag lasts `retainS` (600 s) after the burst's last report.

**DECIDED: a flagged burst casts one shared vote** (`deception.collapseFlaggedOrigins`, on by default). While the flag is raised, every origin in the burst counts as a single vote (id = the flag id), carried by the burst's strongest report. Provenance shows it as one row listing the merged origins. In the scenario, the six planted swarm posts would otherwise lift TRK-1170 to 0.51 with "6 sources". Collapsed, it reads 0.11 from 1 source, with the flag still raised. When the flag expires, the origins vote independently again.

Note this is a deliberate step past the deck's "the system does not adjudicate truth". Nothing is deleted or marked false; the system only declines to treat a suspiciously synchronised cluster as independent corroboration. The pitch wording should change to match, for example: "the system never deletes or overrules reports; it refuses to count coordinated ones as independent." Limitation: CAND labels are assigned during the fold, before flags exist, so label order ignores collapsing.

## 7. Coverage

Each source with a footprint contributes to named **coverage layers**. In the scenario, `uas` is non-cooperative detection (RF, EO) and `cooperative` is ADS-B. The distinction matters: ADS-B "covers" the SW sector, but only for aircraft with transponders, so the SW sector is still blind for drones once RF-SENSE-SW goes down. The snapshot separates `active` footprints (up or degraded) from `lost` ones (down). `isCovered` and `isCoverageLost` answer "nothing there" versus "we cannot see there" versus "we used to see there".

## 8. Determinism

- All randomness goes through a seeded mulberry32 generator, with a separate stream per beat (adding a beat doesn't reshuffle the others).
- Positions are rounded to 1e-7°, sigma to 0.1 m, quality to 0.001, and times to whole ms.
- Same scenario + same seed → byte-identical event stream (tested). A different seed → a different stream.
- Live operator actions get the next free seq at the head, so a run with no live actions republishes the compiled stream exactly (tested).
- Limitation: `Math.log` and `Math.cos` are not guaranteed bit-identical across JS engines. The rounding makes divergence very unlikely, but "byte-identical" is only promised on the same Node/V8.

## 9. The scenario

`scenarios/ber-south-uas-surge.yaml` is about 320 lines, commented, with no code. It contains history from 13:55 (the system was already running), live playback from 14:38:22, the key frame at 14:41:22, and the end at 14:41:52. Beat types are `report`, `periodic`, `burst`, `status`, `verify` and `operator`. The validator lists every problem with a path a designer can act on (`beats[12].report.source: unknown source "NOPE"`).

The scenario numbers are reverse-engineered from slide 7, and a golden test pins the key frame: CTR-004 unresolved with CAND-A hobbyist 0.51 vs CAND-B coordinated pair 0.44; CTR-003 deferred 04:12 by OP-2; TRK-1147 0.93 from 4 sources; TRK-1152 ghosted 41 minutes ago with a 2.4 km envelope; TRK-1160 0.19 from one degraded source; RF 4/6; civilian reports degraded; source reliabilities 0.91 / 0.88 / 0.42 / 0.17; the deception flag on 6 reports; the SW sector blind. After the key frame, police confirm the RF report and OP-1 resolves CTR-004 as hobbyist.

## 10. Server protocol (v1)

WebSocket at `/ws`, JSON messages.

- **Server → client:** `hello` (scenario metadata, clock, last seq) · `events` (log batches; `reset: true` replaces the client's log) · `snapshot` (`view: "live"` or a fixed time) · `clock` · `ack` / `error` (echo `requestId`).
- **Client → server:** `control` (play / pause / restart / speed ≤ 16) · `view` (`"live"` or a past time, clamped to the head, so a client can never see the future) · `operator_action` (checked against a live, unresolved contradiction) · `sync` (resend after a seq).
- **HTTP:** `GET /health` · `GET /log.jsonl`, the full append-only log for after-action review.

The client receives the full log as well as snapshots, so M4's time scrubber can project locally without a round trip.

## 11. Performance (measured)

| case | events | cost |
|---|---|---|
| reference scenario, `project()` at the key frame | 1,305 | ~2–3 ms |
| stress test: 500 entities × 3 sources, a fix every 4 s for 10 min, live `evaluate()` | 225,000 | **~39 ms** per snapshot |
| same, rebuilt from scratch with `project()` (a scrub) | 225,000 | ~500 ms (about 1.8 µs/event) |

The live path fits a 4 Hz feed with headroom. **For M4:** scrubbing a long, dense log needs `Projector` checkpoints (for example every 30 s of sim time), so a scrub replays at most one interval.

## 12. Open items for M2+

1. ~~Review decisions~~: decided. Resolutions are evidence (§4), draw the plausible envelope plus a faint reach ring (§5), flagged bursts are one vote (§6). Both engine behaviours are config switches, so a demo can show either side.
2. Bearing-only reports carry the raw bearing, but their `position` is synthetic: placed along the bearing at the true range. M2 should draw a bearing wedge, not a point, for `bearing` observations.
3. `quality` is a single number for now. If evaluators ask for it, it could be split into detection and classification quality.
4. TypeScript 7 (the native compiler) is used for typechecking. If any M2 tooling (deck.gl types, Vite plugins) objects, pin 5.x.
