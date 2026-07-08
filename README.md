# Tads

**Tads** is a desktop viewer for huge Parquet, CSV, DuckDB, and SQLite
files with a Stata-style command bar. The goal is to bridge the gap
between Stata and Parquet: a lightning-fast way to peruse large files,
filter rows and columns with familiar Stata syntax, and compute simple
summary statistics — without loading anything into Stata. It is not a
general Stata interpreter; it replicates Stata's intuitive data
*exploration* workflow (browse, summarize, tabulate, keep/drop) on top
of an embedded [DuckDB](https://duckdb.org/) engine.

Tads is a fork of [Tad](https://github.com/antonycourtney/tad) by Antony
Courtney, which provides the scrolling data grid (SlickGrid), pivot
table, and SQL-generation core.

## What it does

- Opens multi-gigabyte Parquet/CSV files near-instantly and scrolls
  linearly through millions of rows.
- A **command bar** accepts Stata-style commands with variable
  abbreviation, wildcards (`price*`), backtick quoting for awkward
  names, `if` expressions, Tab completion, and command history.
- An append-only **results pane** shows each command's output (and the
  exact SQL it ran, behind a disclosure).
- The usual Tad GUI remains: pivot, filter, sort, column selection and
  search, formatting, histograms per column.
- Everything is strictly **read-only**: data files are never modified,
  and the command layer only accepts single read-only SELECT statements.

## Supported Stata commands

These are exactly the commands the command bar understands (unique
prefixes shown in brackets are accepted, e.g. `sum` for `summarize`):

| Command | Form | Effect |
| --- | --- | --- |
| `browse` | `bro[wse] [varlist] [if expr]` | Show selected columns / one-off row filter in the grid. |
| `summarize` | `sum[marize] [varlist] [if expr] [, detail]` | N, mean, sd, min, max. Dates get date-aware statistics. `detail` adds Stata-exact percentiles, extremes, variance, skewness, kurtosis. |
| `tabulate` | `tab[ulate] var [if expr] [, missing]` | One-way frequencies with percent and cumulative percent. |
| `codebook` | `codebook [varlist]` | Type, N, missing, distinct, min/max or top values. |
| `describe` | `des[cribe] [varlist]` | Observation count, variable names and types. |
| `ds` | `ds [varlist]` | List variable names. |
| `list` | `list [varlist] [if expr]` | Show the first 200 matching rows. |
| `count` | `cou[nt] [if expr]` | Count matching observations. |
| `order` | `ord[er] varlist [, last]` | Reorder visible columns. |
| `sort` | `so[rt] varlist` | Sort ascending. |
| `gsort` | `gsort [+\|-]var ...` | Sort with per-key direction. |
| `keep` | `keep varlist` / `keep if expr` | Keep variables, or accumulate a session row filter. |
| `drop` | `drop varlist` / `drop if expr` | Drop variables, or accumulate the inverse filter. |
| `histogram` | `hist[ogram] var [if expr] [, bin(#)]` | Frequency histogram of a numeric variable. |

`if` expressions support `==`/`!=`/`<`/`<=`/`>`/`>=` (with `=` and `~=`
as synonyms), `&`, `|`, parentheses, string/number/date literals, and
Stata missing-value syntax: `x == .` / `x != .` / `x < .` (non-missing)
/ `x >= .` (missing) for numerics, and `s == ""` / `s != ""` for
strings (matching both null and the empty string). Anything not in this
table — `generate`, `replace`, `merge`, `regress`, ... — is
intentionally out of scope.

See [doc/stata-commands.md](doc/stata-commands.md) for the complete
language reference, session semantics, and safety guarantees.

## Installing Tads

**Casual users: download a prebuilt installer from
[GitHub Releases](https://github.com/brettmcc/tads/releases)** — no
command line or build step needed. Each release carries a Windows
`.exe`, a macOS `.dmg` (built by the `release-macos` CI workflow), and
Linux `.deb` / `.tar.bz2` packages.

To build an installer yourself instead, the per-platform instructions
are below. Installers are produced with
[electron-builder](https://www.electron.build/) and land in
`packages/tad-app/release/`; they are not checked into the repository
(a Windows installer alone is ~100 MB). electron-builder can only
build installers for the OS it runs on (macOS installers in particular
require a Mac), so build each platform's installer on that platform.
On every platform the build prerequisites are the same: **Node >= 24**
and npm >= 10, then:

```sh
npm install
npm run build
```

### Windows 11 (and Windows 10)

Install with winget (pending review in
[microsoft/winget-pkgs#399350](https://github.com/microsoft/winget-pkgs/pull/399350);
available once that merges):

```powershell
winget install BrettMcCully.Tads
```

or download `Tads.Setup.<version>.exe` from
[Releases](https://github.com/brettmcc/tads/releases), or build it
yourself:

```powershell
npm run dist:win   # -> packages\tad-app\release\Tads Setup <version>.exe
```

Double-click `Tads Setup <version>.exe` and follow the wizard (it is an
NSIS installer; you can pick the install directory). For an unattended
install — e.g. provisioning a lab machine — run it with the NSIS silent
flag:

```powershell
& ".\Tads Setup 0.14.0.exe" /S
```

The build is unsigned, so SmartScreen may warn on first run: click
**More info → Run anyway**. The installer registers Tads as an
**Open With...** handler for `.csv`, `.tsv`, `.parquet`, `.sqlite`,
`.duckdb`, and `.tad` files and adds a Start-menu entry. Uninstall from
**Settings → Apps** like any other application.

### macOS (Apple Silicon or Intel)

Download the dmg from
[Releases](https://github.com/brettmcc/tads/releases) —
`Tads-<version>-arm64.dmg` for Apple Silicon (M1 and later),
`Tads-<version>.dmg` for Intel Macs (both are built on a
macOS GitHub Actions runner by
[`.github/workflows/release-macos.yml`](.github/workflows/release-macos.yml)) —
or build it on a Mac:

```sh
npm run dist:mac      # -> packages/tad-app/release/Tads-<version>.dmg (+ .zip)
npm run dist-arm64 -w packages/tad-app   # explicit arm64 build if needed
```

Open the `.dmg` and drag **Tads** into **Applications**. The build is
not code-signed or notarized, so Gatekeeper will block the first
launch; either right-click the app and choose **Open**, or clear the
quarantine flag:

```sh
xattr -dr com.apple.quarantine /Applications/Tads.app
```

To launch Tads from the terminal (`tad somefile.parquet`), symlink the
bundled launcher script onto your PATH:

```sh
ln -s "/Applications/Tads.app/Contents/Resources/tad.sh" /usr/local/bin/tad
```

### Linux (Debian/Ubuntu, other)

Download `tads_<version>_amd64.deb` or the portable `.tar.bz2` from
[Releases](https://github.com/brettmcc/tads/releases), or build them on
a Linux machine (WSL works):

```sh
npm run dist:linux    # -> .deb, .rpm and .tar.bz2 in packages/tad-app/release/
```

(the `.rpm` target additionally requires `rpmbuild` to be installed and
is not part of published releases). Install the `.deb` with:

```sh
sudo apt install ./tads_<version>_amd64.deb
```

or unpack the `.tar.bz2` anywhere and run the `tads` binary inside it.

### Running without installing

On any platform, `npm run pack` produces an unpacked, runnable app
(e.g. `packages/tad-app/release/win-unpacked/Tads.exe` on Windows) —
useful for smoke-testing a build without touching the installed copy —
and `npm start` runs the app directly from the dev tree.

## Building from source (Windows)

Requirements: **Node >= 24** (see `.nvmrc`) and npm >= 10. No Visual
Studio or Python toolchain is needed: every native dependency ships
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

## Repository layout

The monorepo uses npm workspaces. Packages used to build Tads:

- [**reltab**](./packages/reltab) - programmatic construction and
  execution of relational SQL queries; defines the driver interface and
  the remoting layer between the renderer and the query backend.
- [**reltab-duckdb**](./packages/reltab-duckdb/) - reltab driver for DuckDB.
- [**aggtree**](./packages/aggtree/) - pivot trees on top of reltab.
- [**tadviewer**](./packages/tadviewer/) - the pivot-table UI component,
  the Stata command language (`src/stataCommand/`), command bar, and
  results pane.
- [**tad-app**](./packages/tad-app/) - the Electron desktop application.

Upstream Tad's proof-of-concept packages (web app/server and the AWS
Athena, BigQuery, and Snowflake drivers) have been removed from this
fork; it targets the desktop app and DuckDB only. `reltab-sqlite`
remains in the tree but outside the default build (its legacy `sqlite3`
dependency needs an old native toolchain). See upstream
[antonycourtney/tad](https://github.com/antonycourtney/tad) if you need
them.

## Cross-validation

`summarize, detail`, `tabulate`, and `count` results are cross-validated
against Stata/MP 19 output (see
`packages/tadviewer/test/fixtures/stataCrossValidation.do`).
