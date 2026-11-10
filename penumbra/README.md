# PENUMBRA · Phase 0 prototype

A confidence and decision-support layer above sensor fusion. It renders confidence, age, source lineage and contradiction as visual properties of every entity.

- Plan and build prompt: [PHASE0_PROTOTYPE_BRIEF.md](PHASE0_PROTOTYPE_BRIEF.md)
- M1 design and review notes (confidence maths, schema, decisions): [docs/M1-DESIGN.md](docs/M1-DESIGN.md)
- Dependencies and licences: [DEPENDENCIES.md](DEPENDENCIES.md)

**All data is synthetic.**

## Status

| Milestone | Scope | State |
|---|---|---|
| M1 | data model, confidence engine, scenario engine, WS stream, tests | done, reviewed |
| M2 | map rendering of the four conditions + deception flag | |
| M3 | panels + RESOLVE / DEFER | |
| M4 | time scrubber + LEGACY toggle | |
| M5 | instrumentation, legibility probe, demo / capture mode | |

## Quickstart

Requires Node ≥ 22 and pnpm 10.

```bash
pnpm install
pnpm check          # typecheck + tests
pnpm frame          # print the slide 7 key frame (14:41:22Z) as text
pnpm frame --at 14:39:30 --prov TRK-1155:CAND-B
pnpm dev            # live feed on ws://127.0.0.1:8787/ws
pnpm feed --speed 4 --manual     # 4x, no scripted operator actions
```

## Layout

```
packages/core     types, append-only EventLog, Projector / project(log, t), confidence maths, geo, seeded RNG
packages/sim      scenario format + validation, deterministic compiler
apps/server       WebSocket feed, protocol types, text frame renderer (frame-cli)
scenarios/        designer-editable scenarios (YAML)
docs/             design notes per milestone
```
