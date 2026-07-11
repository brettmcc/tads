---
name: verify
description: Build, launch, and drive the Tads Electron app to verify changes at the UI surface
---

# Verifying Tads changes

## Build
- `npm run build` at repo root builds all workspace packages (~30s incremental).
- Packaged installer: `npm run dist:win` at root → `packages/tad-app/release/Tads Setup <version>.exe`. NSIS silent install (`/S`) auto-runs the app; `Stop-Process -Name Tads -Force` afterward or the single-instance lock breaks later Playwright launches.

## Launch under Playwright
From `packages/tad-app` (its node_modules has playwright-core, electron, @duckdb/node-api):

```js
const { _electron } = require("playwright-core");
const electronPath = require("electron"); // path string in plain Node
const app = await _electron.launch({
  executablePath: electronPath,
  args: [".", "--foreground", /* optional data file path */],
  cwd: appDir, // packages/tad-app
});
const page = await app.firstWindow();
```

- Kill stale `Tads`/`electron` processes first — they make every launch fail instantly.
- Scripts living outside the repo (e.g. scratchpad) must resolve modules via `createRequire(path.join(appDir, "package.json"))`.
- Fixture parquet: create with `@duckdb/node-api` (`COPY t TO '<path>' (FORMAT PARQUET)`); forward-slash the path for DuckDB.
- See `test/e2e.test.ts` and `tools/packagedSmoke.js` for full drive examples (command bar testid `command-input`, grid headers `.slick-header-column`).

## Useful hooks
- Native dialogs: stub in the main process, e.g.
  `app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); })`.
- Empty-startup state: launching with no file arg shows `[data-testid="open-dataset-button"]`; clicking it goes through the `openFileDialog` IPC handler in `app/main.ts`.
- Grid loaded = `.slick-header-column` present. FrozenGrid: programmatic scrolling must target `.slick-viewport-top.slick-viewport-right`.

## Packaged smoke
`node packages/tad-app/tools/packagedSmoke.js` (after `npm run pack` or `dist:win`) drives the packaged app end-to-end and prints PASSED/FAILED.
