# Dependencies and licences

Checked against the installed packages (`pnpm licenses list`). There are no ITAR-relevant, non-EU-hostable or network-calling dependencies, and no CDN or external tile service.

## Runtime (shipped)

| Package | Version | Licence | Used for |
|---|---|---|---|
| ws | 8.22.2 | MIT | WebSocket server |
| yaml | 2.9.1 | ISC | scenario parsing |

## Development only (not shipped)

| Package | Version | Licence | Used for |
|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | typechecking |
| tsx | 4.23.15 | MIT | running TS directly |
| vitest | 5.1.0 | MIT | tests |
| fast-check | 4.10.2 | MIT | property tests |
| @types/node, @types/ws | 26.6.6, 8.18.2 | MIT | type definitions |

Transitive dev dependencies: 39 MIT, 4 Apache-2.0, 2 ISC, 1 BSD-3-Clause (source-map-js), and 3 MPL-2.0 (lightningcss and its platform binaries, pulled in by vitest's bundler). MPL-2.0 is file-level copyleft and dev-only here; nothing from it is shipped.
