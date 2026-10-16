# Developing Tads

Build, test, and release notes for maintainers. User-facing docs are in
the [README](../README.md).

## Building from source

Requirements: **Node >= 24** (see `.nvmrc`) and npm >= 10. Works on
Windows, macOS, and Linux; no Visual Studio or Python toolchain is
needed even on Windows: every native dependency ships
prebuilt binaries (the DuckDB backend uses
[`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api),
prebuilt NAPI bindings).

```sh
npm install        # installs all workspace packages
npm run build      # builds all workspace packages
npm start          # launches the desktop app (or: npm start -- file.parquet)
npm test           # reltab + reltab-duckdb + tadviewer test suites
npm run pack       # packaged app in packages/tad-app/release/win-unpacked
npm run dist       # full distributable installer
```

End-to-end tests for the command bar (require a prior `npm run build`
or `build-dev`):

```sh
npm run test:e2e -w packages/tad-app          # dev-build Electron e2e
node packages/tad-app/tools/packagedSmoke.js  # packaged-app smoke test
```

## Building the installers

Installers are produced with
[electron-builder](https://www.electron.build/) and land in
`packages/tad-app/release/` (not checked in; a Windows installer alone
is ~100 MB). After `npm install && npm run build`:

```sh
npm run dist:win     # NSIS installer (also supports silent installs: Tads.Setup.<v>.exe /S)
npm run dist:mac     # dmg + zip (add -- --arm64 --x64 for both architectures)
npm run dist:linux   # deb + tar.bz2 (+ rpm if rpmbuild is installed)
```

electron-builder can only target the OS it runs on, so building all
three locally means three machines (WSL works for the Linux one). That
is why releases build them in CI instead:
[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on
a Windows, macOS, and Linux runner whenever a release is published and
attaches every installer to it, and can be re-run for an existing tag
with `gh workflow run release.yml -f tag=vX.Y.Z`.

`npm run pack` produces an unpacked runnable app
(`packages/tad-app/release/win-unpacked/`) for smoke-testing without
touching an installed copy. Creating an empty `data` folder next to
`Tads.exe` in it makes it portable, which is how the release workflow
builds the portable Windows zip.

