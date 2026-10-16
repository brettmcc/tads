# Tads

**Tads** is a desktop viewer for huge Parquet, CSV, and DuckDB
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
  exact SQL it ran, behind a disclosure), with **Ctrl+F**
  find-in-results and a drag-to-resize split.
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
| `correlate` | `cor[relate] [varlist] [if expr] [, covariance]` | Correlation matrix (lower triangle) with casewise deletion; `covariance` gives sample covariances. |
| `codebook` | `codebook [varlist] [if expr]` | Type, N, missing, distinct, min/max or top values. |
| `distinct` | `distinct [varlist] [if expr] [, missing joint]` | Observations and distinct values per variable, or per value combination with `joint`. |
| `duplicates report` | `duplicates r[eport] [varlist] [if expr]` | Copies, observations, and surplus for duplicate observations over the varlist. |
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

Options may be abbreviated where unambiguous (`sum, d`, `corr x y, cov`,
`distinct x, j`). `codebook`, `distinct`, and `duplicates` must be
spelled in full, though the `duplicates` subcommand may be abbreviated
(`duplicates r`).

`if` expressions support `==`/`!=`/`<`/`<=`/`>`/`>=` (with `=` and `~=`
as synonyms), `&`, `|`, parentheses, string/number/date literals, and
Stata missing-value syntax: `x == .` / `x != .` / `x < .` (non-missing)
/ `x >= .` (missing) for numerics, and `s == ""` / `s != ""` for
strings (matching both null and the empty string).

See [doc/stata-commands.md](doc/stata-commands.md) for the complete
language reference, session semantics, and safety guarantees.

## Installing Tads

Download an installer from the
**[releases page](https://github.com/brettmcc/tads/releases)**. Tads
is not code-signed yet, so your OS will ask you to confirm the first
launch — the note for each OS below says what to click.

### Windows 10 / 11

**Download:** get `Tads.Setup.<version>.exe`, double-click it, and
follow the wizard. If SmartScreen warns, click **More info → Run
anyway**. Tads then shows up in the Start menu and as an **Open
With...** choice for `.csv`, `.parquet`, `.tad`, and similar files;
uninstall it from **Settings → Apps**.

**Portable (no installation):** get `Tads-<version>-portable-win-x64.zip`,
unpack it anywhere (a folder you can write to, or a USB stick), and run
`Tads.exe` in the `Tads` folder. The `data` folder next to `Tads.exe`
puts Tads in portable mode: everything it writes stays in that folder
instead of your user profile, and nothing is registered with Windows
(no Start menu entry or file associations). To remove it, delete the
folder.

### macOS

**Download:** get `Tads-<version>-arm64.dmg` for Apple Silicon
(M1 or later) or `Tads-<version>.dmg` for Intel Macs. Open it and drag
**Tads** into **Applications**. On first launch, right-click the app
and choose **Open**; if macOS still refuses, allow it under
**System Settings → Privacy & Security → Open Anyway**.

**Package manager:** not on Homebrew yet.

### Linux

**Debian / Ubuntu:** download `tads_<version>_amd64.deb`, then:

```sh
sudo apt install ./tads_<version>_amd64.deb
```

**Fedora / RHEL / openSUSE:** download `tads-<version>.x86_64.rpm`, then:

```sh
sudo dnf install ./tads-<version>.x86_64.rpm
```

**Any other distribution:** download `tads-<version>.tar.bz2`, unpack
it anywhere, and run the `tads` binary inside — no installation needed.

Instructions for building the installers yourself are in
[Building the installers](#building-the-installers) below.

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

### Building the installers

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
[`.github/workflows/release.yml`](.github/workflows/release.yml) runs on
a Windows, macOS, and Linux runner whenever a release is published and
attaches every installer to it, and can be re-run for an existing tag
with `gh workflow run release.yml -f tag=vX.Y.Z`.

`npm run pack` produces an unpacked runnable app
(`packages/tad-app/release/win-unpacked/`) for smoke-testing without
touching an installed copy. Creating an empty `data` folder next to
`Tads.exe` in it makes it portable, which is how the release workflow
builds the portable Windows zip.

On macOS, to launch Tads from the terminal (`tad somefile.parquet`),
symlink the bundled launcher script onto your PATH:

```sh
ln -s "/Applications/Tads.app/Contents/Resources/tad.sh" /usr/local/bin/tad
```

## Cross-validation

`summarize` (with and without `detail`), `tabulate`, `correlate`,
`distinct`, `duplicates report`, and `count` results are cross-validated
against Stata/MP 19 output (see
`packages/tadviewer/test/fixtures/stataCrossValidation.do`).
