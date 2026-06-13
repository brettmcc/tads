# Tads Command Bar

Tads adds a small, deterministic Stata-style command language for fast
exploration of large CSV and Parquet files. It is not a general Stata
interpreter. Commands are schema-aware, execute through a read-only DuckDB
API, and record their generated SQL in the results pane.

## Command bar controls

- Press **Enter** or click **Run** to execute.
- Press **Up/Down** to navigate command history.
- Press **PageUp** to recall the last submitted command.
- Press **Tab** after a partial variable name to complete it. Repeated Tab
  cycles through matches. Names that require quoting are wrapped in backticks.
- Click **Break** to interrupt a running DuckDB query.
- Click **Results** or press **Ctrl+`** to toggle the append-only results pane.
- Click **Clear** in the results pane to clear command history.

The command input is disabled while a command is running. Failed commands keep
their text in the input for correction.

## Commands

| Command | Accepted form | Effect |
| --- | --- | --- |
| `browse` | `bro[wse] [varlist] [if expr]` | Show selected columns and an optional one-off filter in the main grid. |
| `summarize` | `sum[marize] [varlist] [if expr] [, detail]` | N, mean, sample standard deviation, min, and max. `detail` adds exact percentiles, extremes, variance, skewness, kurtosis, and sum for numeric variables. |
| `tabulate` | `tab[ulate] var [if expr] [, missing]` | One-way frequencies, percent, and cumulative percent. Nulls are excluded unless `missing` is given. |
| `codebook` | `codebook [varlist]` | Type, N, missing, distinct, and min/max or top values. |
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

Options may be abbreviated where unambiguous: `sum, d`, `tab x, m`, and
`hist x, bin(20)` are valid.

An omitted varlist means all currently visible variables for commands that
permit it. `tabulate` and `histogram` take exactly one variable.

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
operand    := NUMBER | '-' NUMBER | STRING | 'null'
            | 'date' '(' STRING ')' | varname
```

Parentheses bind first, followed by comparisons, `&`, then `|`.

- `=` is a synonym for `==`; `~=` is a synonym for `!=`.
- String literals may use single or double quotes. Double the delimiter to
  escape it: `'it''s'`, `"say ""hi"""`.
- Null checks must use `x == null` or `x != null`.
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

`tabulate` returns at most 1,000 groups, with percentages computed before the
limit. `codebook` returns at most 10 top values per categorical variable.
`list` returns at most 200 rows. Histogram bins default to
`round(min(sqrt(N), 10*log10(N)))`.

Examples:

```text
bro make price mpg if mpg > 20
sum price weight if foreign == 1
sum price*, detail
tab rep78, missing
describe make price*
list make price if price >= 5000
count if price != null
order make price, last
gsort -price make
keep if year >= 2020
drop temporary_*
histogram price if price > 0, bin(30)
```

## Safety and limits

Tads compiles commands to SQL using the active dialect's identifier and literal
escaping. The command bar never sends raw user SQL. The backend accepts only a
single read-only `SELECT` or `WITH ... SELECT` statement and rejects mutation,
administrative statements, comments, and statement chaining. On-disk DuckDB
files are opened in `READ_ONLY` mode.

Commands operate on one loaded dataset at a time. Pivot groups do not change
command results. DECIMAL summaries use double precision. SQL null comparison
semantics differ from Stata numeric missing values: null satisfies neither an
ordinary comparison nor its logical opposite, so use explicit null checks when
that distinction matters.
