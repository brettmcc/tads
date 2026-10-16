# Tads Command Bar

Tads adds a small, deterministic Stata-style command language for fast
exploration of large CSV and Parquet files. It is not a general Stata
interpreter. Commands are schema-aware, execute through a read-only DuckDB
API, and record their generated SQL in the results pane.

## Command bar controls

- Press **Enter** or click **Run** to execute.
- Press **Up/Down** or **PageUp/PageDown** to navigate command history.
- Press **Tab** after a partial variable name to complete it. Repeated Tab
  cycles through matches. Names that require quoting are wrapped in backticks.
- Click **Break** to interrupt a running DuckDB query.
- Click **Results** or press **Ctrl+`** to toggle the append-only results pane.
- Click **Clear** in the results pane to clear command history.
- Each open dataset keeps its own command line: switching datasets restores
  the command you were typing there, and command history and the results
  pane only cover commands run against the dataset being viewed. **Clear**
  empties just that dataset's results; closing a data source discards them.
- Press **Ctrl+F** (or click the magnifier in the results pane header) to search
  the results. **Enter**/**Shift+Enter** step through matches, **Esc** closes the
  find bar.

The command input is disabled while a command is running. Failed commands keep
their text in the input for correction.

## Commands

| Command | Accepted form | Effect |
| --- | --- | --- |
| `browse` | `bro[wse] [varlist] [if expr]` | Show selected columns and an optional one-off filter in the main grid. |
| `summarize` | `sum[marize] [varlist] [if expr] [, detail]` | N, mean, sample standard deviation, min, and max. Date/timestamp variables report mean/min/max as dates and the standard deviation in days. `detail` adds exact percentiles, extremes, variance, skewness, kurtosis, and sum for numeric variables. |
| `tabulate` | `tab[ulate] var [if expr] [, missing]` | One-way frequencies, percent, and cumulative percent. Nulls are excluded unless `missing` is given. |
| `correlate` | `cor[relate] [varlist] [if expr] [, covariance]` | Lower triangle of the correlation matrix over the numeric variables, using casewise deletion. `covariance` reports sample covariances (variances on the diagonal) instead. |
| `codebook` | `codebook [varlist] [if expr]` | Type, N, missing, distinct, and min/max or top values. |
| `distinct` | `distinct [varlist] [if expr] [, missing joint]` | Observations and distinct values per variable. Missing is excluded from both counts unless `missing` is given, which counts it as one distinct value. `joint` counts distinct combinations of the whole varlist instead. |
| `duplicates report` | `duplicates r[eport] [varlist] [if expr]` | Distribution of duplicate observations over the varlist: copies, observations, and surplus. |
| `describe` | `des[cribe] [varlist]` | Observation count plus variable names and SQL types. |
| `ds` | `ds [varlist]` | List resolved variable names without querying DuckDB. |
| `list` | `list [varlist] [if expr]` | Display the first 200 matching rows. |
| `count` | `cou[nt] [if expr]` | Count matching observations. |
| `order` | `ord[er] varlist [, last]` | Move variables to the front or end of the visible column order. |
| `sort` | `so[rt] varlist` | Sort the grid ascending by each key. |
| `gsort` | `gsort [+|-]var ...` | Sort the grid with per-key direction; `-` is descending and `+` is ascending. |
| `keep` | `keep varlist` or `keep if expr` | Keep visible variables, or accumulate a persistent row filter. |
| `drop` | `drop varlist` or `drop if expr` | Drop visible variables, or accumulate the inverse of a row filter. |
| `histogram` | `hist[ogram] var [if expr] [, bin(#)]` | Render a frequency histogram for a numeric variable. |
| `scatter` | `[tw[oway]] sc[atter] yvar [yvar ...] xvar [if expr]` | Scatter plot of one or more numeric or date y variables against an x variable. |

`summarize`, `tabulate`, `correlate`, `distinct`, `list`, and `count` also
take a `by varlist:` / `bysort varlist:` prefix; see [By groups](#by-groups).

Options may be abbreviated where unambiguous: `sum, d`, `tab x, m`,
`corr x y, cov`, `distinct x, j`, and `hist x, bin(20)` are valid.
`codebook`, `distinct`, and `duplicates` must be spelled in full, though the
`duplicates` subcommand may be abbreviated (`duplicates r`). Only the `report`
subcommand is implemented; Stata's `examples`, `list`, `tag`, and `drop`
subcommands are rejected with a message.

An omitted varlist means all currently visible variables for commands that
permit it. `tabulate` and `histogram` take exactly one variable.
`scatter` takes at least two: every variable but the last is plotted against
the last, each y variable in its own color.

## By groups

`summarize`, `tabulate`, `correlate`, `distinct`, `list`, and `count` accept
Stata's `by` prefix and repeat their output for each group, introduced by a
`-> var = value` header:

```text
bysort region: sum price mpg
by year month: tab status, missing
bys firm (date): list date price if price > 100
by group, sort: distinct id, joint
```

- `by`, `bys[ort]`, and `by varlist, sort:` are interchangeable. Groups are
  always formed in sorted order, so Stata's "not sorted" error for a plain
  `by` cannot arise.
- Groups are listed in ascending order of the by variables, missing last
  (shown as `.`). Several by variables group on each combination:
  `-> foreign = 0, rep78 = 3`.
- As in Stata, groups come from the session dataset (after `keep if` /
  `drop if`), not from the command's own `if`: a group whose observations
  all fail the `if` is still shown, with N = 0 (or, for `list`, nothing).
- Variables in parentheses (`bysort g (x):`) only order observations within
  each group; they matter for `list`.
- Other commands are rejected with Stata's "may not be combined with by"
  message. That includes `keep if` and `drop if`: Stata accepts them under
  `by`, but without `_n`/`_N` the prefix cannot change their result, so Tads
  reports an error instead of silently ignoring it.
- At most 500 groups are reported (the first in sort order); a note gives
  the total. `list` shows up to 200 rows per group and numbers them within
  the group.

The number of queries does not grow with the number of groups: every
group's statistics come out of the same grouped query (one per variable for
`summarize, detail`, as without `by`), plus one query listing the groups,
which reads only the by variables.

By-group results for `summarize` (with and without `detail`), `tabulate`,
`distinct`, and `count`, including the group order and the groups an `if`
empties, are cross-validated against Stata 19.

## Session behavior

The command session's columns are the columns currently visible in the grid,
in display order. `browse`, `keep`, `drop`, `order`, and changes made in the
Columns sidebar therefore affect which variables later commands can see.

`keep if` and `drop if` accumulate a persistent session row filter. Later
statistics combine that filter with their own `if` clause. The filter is reset
when a different dataset or saved view is opened.

A `browse if` clause changes the current grid filter but is not added to the
persistent session filter. Use `keep if` when later commands should operate on
the same subset.

## Variables and wildcards

Variable matching is case-sensitive:

- An exact match wins.
- An unquoted unique prefix is accepted: `tab dep` can resolve to
  `department`.
- `*` matches any run of characters and `?` matches one character in a
  varlist. Patterns expand in current schema order.
- A bare `*` means all visible variables.
- Wildcards are not allowed where a command requires one variable or inside an
  expression.
- Backtick-quoted names resolve exactly and do not expand wildcards:
  ``sum `gross margin` ``.
- Double a literal backtick inside a quoted name:
  ``list `name``with``ticks` ``.
- The contextual names `if`, `null`, and `date` must be backtick-quoted when
  used as variables.

Overlapping wildcard patterns are de-duplicated. Repeating the same explicit
variable is an error.

## If expressions

```text
expr       := orExpr
orExpr     := andExpr ( '|' andExpr )*
andExpr    := boolPrim ( '&' boolPrim )*
boolPrim   := '(' orExpr ')' | comparison
comparison := operand relop operand
relop      := '==' | '=' | '!=' | '~=' | '<' | '<=' | '>' | '>='
operand    := NUMBER | '-' NUMBER | STRING | 'null' | '.'
            | 'date' '(' STRING ')' | varname
```

Parentheses bind first, followed by comparisons, `&`, then `|`.

- `=` is a synonym for `==`; `~=` is a synonym for `!=`.
- String literals may use single or double quotes. Double the delimiter to
  escape it: `'it''s'`, `"say ""hi"""`.
- Null checks may use `x == null` / `x != null` or the Stata missing-value
  forms below.
- A bare `.` is the numeric missing-value literal: `x == .` and `x != .`
  test missingness, and the Stata idioms `x < .` (non-missing) and
  `x >= .` (missing) are recognized. `x <= .` and `x > .` are rejected
  (without extended missing values they are always/never true).
- `x == ""` and `x != ""` follow Stata's string-missing convention: they
  match (or exclude) both null and the empty string.
- Date literals use `date("YYYY-MM-DD")` or
  `date("YYYY-MM-DD HH:MM[:SS]")`. A `T` separator is also accepted.
- Column-to-column comparisons are supported.
- Arithmetic and arbitrary function calls are intentionally unsupported.

## Output details

`summarize, detail` uses Stata's percentile definition: when `N*p/100` is an
integer, it averages the adjacent order statistics; otherwise it uses the
ceiling order statistic. Skewness and kurtosis use population central moments,
while variance and standard deviation use sample definitions. The fixture
results are cross-validated against Stata 19.

`correlate` follows Stata in deleting missing values casewise: an observation
enters the matrix only if every listed variable is non-null there, so the
reported `(obs=N)` applies to every cell. Non-numeric variables in the varlist
are omitted with a note, and correlations display with four decimals.
Covariances are the sample (N−1) definition. Both forms are cross-validated
against Stata 19.

`distinct` follows Stata's `distinct` (Nicholas J. Cox): the reported total is
the number of non-missing observations and the distinct count excludes missing,
unless `missing` is given, in which case the total is every observation and
missing counts as one distinct value. `joint` treats the varlist as one unit and
deletes casewise, so an observation contributes only when every listed variable
is non-missing there (again unless `missing` is given). Both forms are
cross-validated against Stata 19.

`duplicates report` follows Stata: observations are grouped by the varlist and
the group sizes are rolled up into one row per distinct size, where
`Observations` is how many observations have that many copies and `Surplus` is
how many of them a `duplicates drop` would remove. An omitted varlist means all
visible variables. Missing is an ordinary value here, so two observations that
are missing in the same variables are duplicates of each other — unlike
`distinct`, nothing is deleted casewise. The header echoes the varlist, and a
trailing line gives the totals. Cross-validated against Stata 19.

`tabulate` returns at most 1,000 groups, with percentages computed before the
limit and displayed with two decimals. Numeric values keep their numeric
display formatting (grouping only from 10,000 up, so years read cleanly).
`codebook` returns at most 10 top values per categorical variable.
`list` returns at most 200 rows. Histogram bins default to
`round(min(sqrt(N), 10*log10(N)))`.

`scatter` uses an observation when x and at least one y variable are
non-missing; each y variable plots only where it is non-missing itself. So
that large files plot quickly without losing anything, the plot area is split
into a fine grid (192 x 126 cells, about 2 pixels each) and DuckDB returns the
occupied cells with their observation counts. Every observation, outliers
included, lands in a drawn cell; cells holding more observations are drawn
brighter. The result size stays bounded no matter how many rows there are, and
at this resolution the plot looks the same as one drawn point by point. The
caption reports N. Variables
may be numeric or date/timestamp (with date axes), though the y variables
must be all numeric or all dates. Graph options such as `msize()` are not
supported.

Examples:

```text
bro make price mpg if mpg > 20
sum price weight if foreign == 1
sum price*, detail
bysort foreign: sum price mpg
tab rep78, missing
correlate price weight mpg if foreign == 0
corr price mpg, covariance
distinct make rep78
distinct make model, joint
duplicates report
duplicates report make model if year >= 2020
describe make price*
list make price if price >= 5000
count if price != .
drop if name == ""
order make price, last
gsort -price make
keep if year >= 2020
drop temporary_*
histogram price if price > 0, bin(30)
scatter price mpg if foreign == 1
twoway scatter price weight length
```

## Performance

Parquet files open instantly as a zero-copy view: every command re-reads the
file, which DuckDB parallelizes across row groups. For repeated statistics on
the same dataset, the **In memory** toggle in the footer loads the data into
an in-memory DuckDB table (using RAM roughly proportional to the uncompressed
data size); toggle it off to release the memory. If the estimated size exceeds
the memory currently free, Tads asks before loading. While loaded, a warning
icon appears next to the toggle if part of the copy has spilled to disk or
system memory is running low — hover it for the explanation. DuckDB is
configured with one less thread than the machine's core count so the grid
stays responsive while a heavy statistic runs.

## Safety and limits

Tads compiles commands to SQL using the active dialect's identifier and literal
escaping. The command bar never sends raw user SQL. The backend accepts only a
single read-only `SELECT` or `WITH ... SELECT` statement and rejects mutation,
administrative statements, comments, and statement chaining. On-disk DuckDB
files are opened in `READ_ONLY` mode.

Commands operate on one loaded dataset at a time. Pivot groups do not change
command results. DECIMAL summaries use double precision. SQL null comparison
semantics differ from Stata numeric missing values: null satisfies neither an
ordinary comparison nor its logical opposite (`drop if x > 2` does not drop
rows with missing x), so use explicit missingness checks (`== .`, `!= .`,
`== null`) when that distinction matters.
