# PENUMBRA — Phase 0 Prototype Brief

Source: *PENUMBRA Threat Interface* pitch deck (Stratosphere Solutions Berlin, September 2026).
Phase 0 window: now – December 2026. Target: NATO DIANA 2028 Challenge Call (expected June 2027), which requires TRL 4.

## Recommendation

Build one thing for Phase 0: a live, playable version of the slide 7 screen. It runs a scripted drone-surge scenario on a synthetic feed and has one toggle that redraws the same data the way fielded systems show it.

The Phase 0 slide sets the goal as a screenshot that makes an evaluator ask why their system doesn't do that. That question comes fastest when they can flip between both views of the same moment themselves.

## Approach

**What to build now.** Subsystem 01, the confidence-native visualisation. Add a thin slice of Subsystem 03: record every operator action and let the user scrub back through the picture. Both are cheap if the data model is right. Leave the agent sandbox (Subsystem 02) for Phase 1.

**Key decisions**

1. **Make the prototype work the way slide 12 says the product works.** Store observations in an append-only log and compute confidence when it's read, never store it. Built that way, two things come almost free: replaying the picture as it stood at any past moment, and the groundwork for counterfactual replay in Phase 1. It also turns the prototype into evidence for the technical claims rather than a throwaway.
2. **Treat the scenario like a game level.** A designer should be able to write the story beats in a file. Runs should be deterministic: the same seed always gives the same event stream. This is how the studio already builds vertical slices and replays.
3. **The legacy toggle is the demo.** It needs to be a fair copy of fielded systems: one best-estimate symbol per track, no ageing, contradictions resolved by picking one, no coverage layer. If it looks like a strawman, evaluators will dismiss it.
4. **Keep standard military symbols and change how they're drawn.** Use APP-6 symbols (the milsymbol library, MIT licence) and vary their ring, edge and saturation with confidence. "We modulate your symbology, we don't replace it" makes adoption easier to argue.
5. **Measure legibility from the first week.** The Phase 0 criterion says "operator-legible", so test it: freeze a frame, ask three questions, record whether answers are right and how long they take, in both views. Internal numbers now prepare the method for Phase 2, and measurement is one of the strengths the deck claims (slide 13).
6. **Choose a web client.** Evaluators can open a URL, it's easy to capture as video, and it's quick to change. Use deck.gl and MapLibre with no external map tiles, so it works air-gapped and avoids any licence dependency.

## Plan

Five milestones of one to two weeks each, with one Claude Code session per milestone. Review between milestones rather than handing over one huge prompt.

| Milestone | Content |
|---|---|
| M1 | Data model, confidence engine, scenario engine, WebSocket stream, tests (no UI polish) |
| M2 | Map rendering of the four conditions + deception flag |
| M3 | Panels + RESOLVE / DEFER |
| M4 | Time scrubber + LEGACY toggle |
| M5 | Instrumentation, legibility probe, demo / capture mode |

## Two things to watch

- **Keep the scope tight.** The pull will be to fake a bit of counterfactual replay or adversary agents for the demo. Don't. The time scrubber already shows that the architecture supports it, and that's the honest Phase 1 hook.
- **Collect legibility numbers early.** Run the probe with even ten internal people in both views. Evidence like "operators answered 2× faster and more accurately in PENUMBRA view" is more persuasive to the DIANA panel than polish.

---

## Build prompt

How to use it: export slide 7 of the deck as a PNG from PowerPoint, attach it as `slide7.png`, and run the first session in plan mode.

```text
You are building the Phase 0 prototype for PENUMBRA, a confidence and decision-support layer that sits ABOVE sensor fusion in a common operational picture (COP). Fielded COPs draw a confirmed track and an unverified 3-hour-old report with the same symbol. PENUMBRA renders confidence, age, source lineage and contradiction as visual properties of every entity.

Attached: slide7.png. This is the target screen. Treat its layout, information density and palette (near-black navy, cyan = corroborated, orange = contradicted/low reliability, amber = degraded, grey dashed = aged/ghost) as the visual spec.

## Phase 0 success criterion
"An operator-legible confidence picture on a live synthetic feed." The demo must make an evaluator ask why their existing system cannot do this.

## Scenario (the only one for Phase 0)
Surge of uncoordinated drone detections near Berlin Brandenburg (EDDB) during a major public event. The hard part is false-positive discrimination under time pressure, not sensor coverage. All data synthetic.

## In scope
1. Confidence-native map rendering of exactly these four conditions:
   a. Confidence as a continuous visual property (ring density, edge sharpness, fill saturation), applied to APP-6 symbols via milsymbol, not replacing them.
   b. Ghost tracks: once fixes stop, the icon becomes an expanding uncertainty envelope (kinematic bound from the class's max speed, capped by endurance), not a stale icon.
   c. Contradictions: two incompatible hypotheses for one contact are both shown with separate confidences and a link between them. Never averaged.
   d. Coverage map: "covered and empty" must look clearly different from "cannot see here". A sensor going down visibly removes its footprint (e.g. RF shadow, sector SW).
   Also: deception/anomaly flag (e.g. 6 low-reliability reports with suspiciously correlated arrival timing). It FLAGS, never adjudicates.
2. Panels as in slide7.png: status bar (feed health, UTC clock), contradiction register (unresolved/deferred with timers), source reliability bars, provenance panel for the selected entity (per-source contributions that sum to the displayed confidence, processing chain), RESOLVE / DEFER actions.
3. Time scrubber: reconstruct the picture exactly as it appeared at any past moment, including operator actions.
4. LEGACY toggle: the same data rendered the way fielded COPs do (single best-estimate symbol, no ageing, contradiction resolved by picking max, no coverage layer). It must be a fair copy, not a strawman.
5. Instrumentation: every operator interaction logged with timestamps to JSONL. A "legibility probe" mode freezes a frame and asks: which contact is least reliable, where can we not see, which track is stale. It records answer + latency in both PENUMBRA and LEGACY modes.
6. A banner reading "EXERCISE · SYNTHETIC DATA" alongside the mock releasability marking.

## Out of scope (do not build)
Adversarial agent sandbox, real sensor integration, real NL parsing (civilian-call parses are pre-scripted in the scenario and labelled "AI-extracted"), auth, multi-user, accreditation.

## Architecture (non-negotiable: these mirror claims in the pitch)
- Server-authoritative: a TypeScript server runs a deterministic, seeded, tick-based scenario engine and streams observations over WebSocket. The client is a thin GPU renderer.
- Provenance IS the entity model: append-only observation log. Entity state and confidence are computed on read for a given time t, never stored as a bare number.
- Confidence must be explainable: decomposable into per-observation contributions that sum to the displayed value. Each source type has a reliability (Beta-distributed, updated by confirm/falsify events) and a decay half-life.
- Scenario defined in a designer-editable YAML/JSON file of timed beats (spawn, report, sensor degrade, confirm, falsify, inject deception).
- Shape the observation schema so a SAPIENT or Cursor-on-Target adapter is a thin mapping later. Do not implement one.
- Stack: pnpm monorepo, TypeScript throughout, Vite + React for panels, deck.gl + MapLibre for the map with NO external tile/CDN dependency (must run air-gapped). Custom deck.gl layers/shaders for envelopes, rings, coverage hatching. No ITAR-encumbered or non-EU-hostable dependencies. List every dependency with its licence.

## Demo scenario beats (~3 min at 1x, playable at 0.5x–4x)
T0 normal ADS-B traffic → first RF detection (single source, low conf) → corroboration raises TRK-1147 to high conf with 4 sources → TRK-1152 loses fixes and ghosts, envelope grows → RF bearing says "hobbyist", two civilian calls say "coordinated pair": CTR-004 contradiction → social-scrape burst triggers DECEPTION FLAG → RF sensor drops (RF SENSE 4/6), SW coverage shadow appears → operator defers CTR-003, resolves CTR-004 → scrub back to 14:36 to show what the operator saw then. Hitting the slide7.png composition at ~14:41:22Z is a hard requirement.

## Acceptance
- Same seed → byte-identical event stream (test).
- Provenance contributions sum to the displayed confidence for every entity at every t (property test).
- 60 fps with 500 live entities on a mid-range laptop, integrated GPU.
- `pnpm dev` starts everything; `pnpm demo` runs the scripted scenario full screen with a 1080p capture mode.

## Working method
Milestones. Stop after each one for review:
M1 data model, confidence engine, scenario engine, WS stream, tests (no UI polish)
M2 map rendering of the four conditions + deception flag
M3 panels + RESOLVE/DEFER
M4 time scrubber + LEGACY toggle
M5 instrumentation, legibility probe, demo/capture mode
Start by proposing the plan, the confidence maths and the observation schema for M1. Wait for approval, then implement M1 only.
```
