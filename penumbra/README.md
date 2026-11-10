# PENUMBRA · Phase 0 prototype

A confidence and decision-support layer above sensor fusion. It renders confidence, age, source lineage and contradiction as visual properties of every entity.

- Plan and build prompt: [PHASE0_PROTOTYPE_BRIEF.md](PHASE0_PROTOTYPE_BRIEF.md)
- M1 design and review notes (confidence maths, schema, decisions): [docs/M1-DESIGN.md](docs/M1-DESIGN.md)
- M2 map rendering notes and screenshots: [docs/M2-NOTES.md](docs/M2-NOTES.md)
- Dependencies and licences: [DEPENDENCIES.md](DEPENDENCIES.md)

**All data is synthetic.**

## Status

| Milestone | Scope | State |
|---|---|---|
| M1 | data model, confidence engine, scenario engine, WS stream, tests | done, reviewed |
| M2 | map rendering of the four conditions + deception flag | done, awaiting review |
| M3 | panels + RESOLVE / DEFER | |
| M4 | time scrubber + LEGACY toggle | |
| M5 | instrumentation, legibility probe, demo / capture mode | |

## Quickstart

Requires Node ≥ 22 and pnpm 10.

```bash
pnpm install
pnpm check          # typecheck + tests
pnpm dev            # feed server + map client: open http://127.0.0.1:5173
pnpm client         # map client only (falls back to offline playback)
pnpm feed --speed 4 --manual     # feed server only, 4x, no scripted operator actions
pnpm frame          # print the slide 7 key frame (14:41:22Z) as text
pnpm frame --at 14:39:30 --prov TRK-1155:CAND-B
pnpm shot           # screenshot the key frame to docs/screens/
pnpm smoke          # live-mode browser smoke test
pnpm build          # static client build (offline mode works without a server)
```

Client URL options: `?t=14:41:22` (freeze a moment), `?mode=offline`, `?speed=4`, `?stress=500&stats` (performance check). See [docs/M2-NOTES.md](docs/M2-NOTES.md).

## Layout

```
packages/core     types, append-only EventLog, Projector / project(log, t), confidence maths, geo, seeded RNG
packages/sim      scenario format + validation, deterministic compiler, feed protocol types
apps/server       WebSocket feed, text frame renderer (frame-cli)
apps/client       map client: Vite + React + deck.gl, custom confidence layer, offline player
scenarios/        designer-editable scenarios (YAML)
docs/             design notes per milestone
```
