# PENUMBRA · Phase 0 prototype

A confidence and decision-support layer above sensor fusion. It renders confidence, age, source lineage and contradiction as visual properties of every entity.

- Plan and build prompt: [PHASE0_PROTOTYPE_BRIEF.md](PHASE0_PROTOTYPE_BRIEF.md)
- M1 design and review notes (confidence maths, schema, decisions): [docs/M1-DESIGN.md](docs/M1-DESIGN.md)
- M2 map rendering notes and screenshots: [docs/M2-NOTES.md](docs/M2-NOTES.md)
- M3 panels and operator actions: [docs/M3-NOTES.md](docs/M3-NOTES.md)
- EDDB basemap: source, georeference, licence note: [docs/BASEMAP.md](docs/BASEMAP.md)
- M4 time scrubber and LEGACY view: [docs/M4-NOTES.md](docs/M4-NOTES.md)
- M5 session logs, legibility probe, demo and recording: [docs/M5-NOTES.md](docs/M5-NOTES.md)
- Dependencies and licences: [DEPENDENCIES.md](DEPENDENCIES.md)

**All data is synthetic.** The airport layout is traced from R. Aehnelt's EDDB chart (Wikimedia Commons, CC); see [docs/BASEMAP.md](docs/BASEMAP.md). Not for navigation.

## Status

| Milestone | Scope | State |
|---|---|---|
| M1 | data model, confidence engine, scenario engine, WS stream, tests | done, reviewed |
| M2 | map rendering of the four conditions + deception flag | done |
| M3 | panels + RESOLVE / DEFER | done |
| M4 | time scrubber + LEGACY toggle | done |
| M5 | instrumentation, legibility probe, demo / capture mode | done, awaiting review |

## Quickstart

Requires Node ≥ 22 and pnpm 10.

```bash
pnpm install
pnpm check          # typecheck + tests
pnpm dev            # feed server (interactive) + client: open http://127.0.0.1:5173
pnpm client         # map client only (falls back to offline playback)
pnpm feed --speed 4 --manual     # feed server only, 4x, no scripted operator actions
pnpm frame          # print the slide 7 key frame (14:41:22Z) as text
pnpm frame --at 14:39:30 --prov TRK-1155:CAND-B
pnpm shot           # screenshot the key frame to docs/screens/
pnpm smoke          # live-mode browser smoke test
pnpm build          # static client build (offline mode works without a server)
pnpm demo           # scripted walkthrough with captions (opens the browser)
pnpm demo:record    # record the walkthrough to recordings/ at 1920 x 1080
pnpm probe:report   # legibility probe results table from ./sessions
pnpm probe:smoke    # probe end-to-end browser test
```

Legibility probe: run `pnpm dev`, open http://127.0.0.1:5173/?probe, then `pnpm probe:report`.

On Windows PowerShell 5.1, run each command on its own line (`&&` is not supported).

Client URL options: `?t=14:41:22` (freeze a moment), `?mode=offline`, `?speed=4`, `?op=OP-3`, `?scripted`, `?stress=500&stats` (performance check). `?view=legacy`, `?replay=14:36:00`, `?probe`, `?demo`, `?capture=1080p`. Keys: space play/pause, `R` resolve, `D` defer, `V` PENUMBRA / LEGACY, ← → replay (Shift = 1 min), End back to live. See [docs/M2-NOTES.md](docs/M2-NOTES.md).

## Layout

```
packages/core     types, append-only EventLog, Projector / project(log, t), confidence maths, geo, seeded RNG
packages/sim      scenario format + validation, deterministic compiler, feed protocol types
apps/server       WebSocket feed, text frame renderer (frame-cli)
apps/client       map client: Vite + React + deck.gl, custom confidence layer, offline player
scenarios/        designer-editable scenarios (YAML)
docs/             design notes per milestone
```
