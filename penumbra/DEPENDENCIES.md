# Dependencies and licences

Checked against the installed packages (`pnpm licenses list`). There are no ITAR-relevant, non-EU-hostable or network-calling dependencies, and no CDN, external font or tile service: the client uses system monospace fonts and a synthetic basemap. Playwright (pre-installed in the dev container) is used only by `pnpm shot` / `pnpm smoke`.

## Runtime (shipped)

| Package | Version | Licence | Used for |
|---|---|---|---|
| ws | 8.22.2 | MIT | WebSocket server |
| yaml | 2.9.1 | ISC | scenario parsing |
| @deck.gl/core, layers, extensions, react | 9.4.1 | MIT | map rendering (WebGL) |
| milsymbol | 3.0.5 | MIT | APP-6 / 2525 symbols |
| react, react-dom | 19.3.1 | MIT | client UI |

## Development only (not shipped)

| Package | Version | Licence | Used for |
|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | typechecking |
| tsx | 4.23.15 | MIT | running TS directly |
| vitest | 5.1.0 | MIT | tests |
| fast-check | 4.10.2 | MIT | property tests |
| vite, @vitejs/plugin-react | 8.3.7, 6.3.0 | MIT | client dev server and build |
| @types/react, @types/react-dom | 19.3.0 | MIT | type definitions |
| @types/node, @types/ws | 26.6.6, 8.18.2 | MIT | type definitions |

Transitive dev dependencies: 39 MIT, 4 Apache-2.0, 2 ISC, 1 BSD-3-Clause (source-map-js), and 3 MPL-2.0 (lightningcss and its platform binaries, pulled in by vitest's bundler). MPL-2.0 is file-level copyleft and dev-only here; nothing from it is shipped.

## Data

| Data | Source | Licence | Used for |
|---|---|---|---|
| EDDB airport layout (traced geometry in `apps/client/src/map/ber-layout.ts`) | "Airport Layout 08/2026", R. Aehnelt via Wikimedia Commons | Creative Commons; **confirm the exact version (BY-SA implies share-alike for the traced geometry) before external use** | basemap |
