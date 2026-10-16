# Tads

**Tads** is a desktop viewer for huge Parquet, CSV, and DuckDB
files with a Stata-style command bar. Browse millions of rows, filter
rows and columns with familiar Stata syntax, and compute summary
statistics, without loading anything into Stata. It covers Stata's
data *exploration* workflow (browse, summarize, tabulate, keep/drop),
not the whole language.

## What it does

- Opens multi-gigabyte Parquet and CSV files near-instantly and
  scrolls smoothly through millions of rows.
- A **command bar** takes Stata-style commands, with variable
  abbreviations, wildcards (`price*`), `if` expressions, Tab
  completion, and command history.
- A **results pane** keeps each command's output, searchable with
  **Ctrl+F**.
- Point-and-click pivoting, filtering, sorting, and column selection
  work alongside the commands.
- **Read-only:** Tads never modifies your files.

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
`Tads.exe` in the `Tads` folder. Everything it writes stays in that
folder and nothing is registered with Windows; to remove it, delete
the folder.

### macOS

**Download:** get `Tads-<version>-arm64.dmg` for Apple Silicon
(M1 or later) or `Tads-<version>.dmg` for Intel Macs. Open it and drag
**Tads** into **Applications**. On first launch, right-click the app
and choose **Open**; if macOS still refuses, allow it under
**System Settings → Privacy & Security → Open Anyway**.

To launch Tads from the terminal (`tad somefile.parquet`), link the
bundled launcher onto your PATH:

```sh
ln -s "/Applications/Tads.app/Contents/Resources/tad.sh" /usr/local/bin/tad
```

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
| `scatter` | `sc[atter] yvar [yvar ...] xvar [if expr]` | Scatter plot of y variables against x; every observation shows, however large the file. |

Options may be abbreviated where unambiguous (`sum, d`, `corr x y, cov`,
`distinct x, j`). `codebook`, `distinct`, and `duplicates` must be
spelled in full, though the `duplicates` subcommand may be abbreviated
(`duplicates r`).

`summarize`, `tabulate`, `correlate`, `distinct`, `list`, and `count`
also run once per group under a `by`/`bysort` prefix, as in Stata:
`bysort region: sum price`, `by year month: tab status`.

`if` expressions support `==`/`!=`/`<`/`<=`/`>`/`>=` (with `=` and `~=`
as synonyms), `&`, `|`, parentheses, string/number/date literals, and
Stata missing-value syntax: `x == .` / `x != .` / `x < .` (non-missing)
/ `x >= .` (missing) for numerics, and `s == ""` / `s != ""` for
strings (matching both null and the empty string).

See [doc/stata-commands.md](doc/stata-commands.md) for the complete
language reference, session semantics, and safety guarantees.

## Accuracy

Results from `summarize` (with and without `detail`), `tabulate`,
`correlate`, `distinct`, `duplicates report`, and `count` — including
their `by`-prefixed forms — are tested against Stata/MP 19 output on the
same data.

## Credits

Tads is a fork of [Tad](https://github.com/antonycourtney/tad) by Antony
Courtney and runs on [DuckDB](https://duckdb.org/).
