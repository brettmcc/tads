# Stata-Style Command Bar

This fork of Tad adds a Stata-like command bar and a toggleable,
append-only results pane to the desktop app. The goal is fast,
keyboard-driven exploration of large Parquet/CSV files with familiar
Stata idioms — not a general Stata interpreter. The grammar is
deliberately small, deterministic, and schema-aware, and every command
records the exact SQL it generated.

## Using the command bar

The command bar sits directly under the data grid. Type a command and
press **Enter** (or click **Run**). **Up/Down** arrows navigate command
history. The input is disabled while a command is running, and after an
error your typed command is preserved for correction.

The results pane opens automatically for `sum`, `tab`, `codebook`, and
errors. `browse` updates the main grid and logs a compact entry. Toggle
the pane with the **Results** button or **Ctrl+`** (backquote). **Clear**
empties the history without hiding the pane. Each successful entry has
an expandable **SQL** section showing exactly what was executed.

## Commands

| Command | Forms accepted | Effect |
| --- | --- | --- |
| `browse varlist [if expr]` | `bro`, `brow`, `brows`, `browse` | Project the listed columns (in order) and filter the main grid. The underlying dataset is untouched; the next command still sees all columns. |
| `summarize varlist [if expr]` | `sum`, `summ`, …, `summarize` | One row per variable: N (non-null), Mean, Std. dev. (`stddev_samp`), Min, Max. Non-numeric variables report N with the numeric statistics blank. |
| `tabulate var [if expr]` | `tab`, `tabu`, …, `tabulate` | Frequency, percent, and cumulative percent per distinct value, sorted ascending. `NULL` is excluded (like simple Stata `tab`); percents are relative to the non-null filtered rows. |
| `codebook varlist` | `codebook` | Per variable: SQL type, N, Missing, Distinct (exact `COUNT(DISTINCT …)`), then Min/Max for numeric and date/timestamp variables, or the top 10 values by frequency (ties broken by value, ascending) for everything else. No `if` clause. |

Command names are lowercase, as in Stata. An omitted varlist for
`browse`, `summarize`, and `codebook` means *all columns*. `tab` takes
exactly one variable.

## Variables

Variable names resolve against the columns of the loaded dataset:

- An **exact match** always wins.
- Otherwise a name may abbreviate a column by any **unique prefix**
  (`tab dep` works if exactly one column starts with `dep`); ambiguous
  prefixes produce an error listing the candidates. Matching is
  case-sensitive, as in Stata.
- Names containing spaces, punctuation, reserved words, or quotes are
  written between **backticks**: `` bro `has space` `select` ``. Write a
  literal backtick by doubling it. Backtick-quoted names resolve
  exactly, never by prefix.
- The contextual keywords `if`, `null`, and `date` can be used as
  variable names by backtick-quoting them.

## Expressions (`if` clause)

```
expr       := orExpr
orExpr     := andExpr ( '|' andExpr )*
andExpr    := boolPrim ( '&' boolPrim )*
boolPrim   := '(' orExpr ')' | comparison
comparison := operand relop operand
relop      := '==' | '=' | '!=' | '~=' | '<' | '<=' | '>' | '>='
operand    := NUMBER | '-' NUMBER | STRING | 'null'
            | 'date' '(' STRING ')' | varname
```

Precedence, tightest first: parentheses, comparison, `&`, `|`.

- `=` is a synonym for `==`; `~=` for `!=`.
- String literals use single or double quotes; double the quote
  character to escape it: `'it''s'`, `"say ""hi"""`.
- Null checks are explicit: `x == null`, `x != null` (other operators
  with `null` are rejected).
- Date and timestamp literals use a deterministic form:
  `date("2026-06-12")` or `date("2026-06-12 10:30:00")` (a `T`
  separator is also accepted). They compile to SQL `DATE '…'` /
  `TIMESTAMP '…'` literals.
- Comparisons between two columns are allowed: `if a > b`.
- Arithmetic, functions, and anything not listed above are out of
  scope by design.

Examples:

```
bro make price if mpg > 20 & price != null
sum price weight if foreign == 1
tab rep78 if price >= 5000
codebook make price mpg
sum `gross margin` if `select` == 'yes' & d >= date("2026-01-01")
```

## Execution model and safety

Commands are parsed and validated against the active schema, then
compiled to SQL through the active dialect's identifier quoting with
correct literal escaping. `browse` compiles to the same filter
representation used by Tad's filter UI and updates the grid in place.
`sum`/`tab`/`codebook` run through a narrowly scoped read-only SQL API:
a single `SELECT`/`WITH … SELECT` statement per call, no comments, no
statement chaining — mutation and administrative statements are
rejected server-side. The command bar never sends raw user SQL; only
SQL produced by the planners is executed.

`bigint` and date values are normalized consistently across the
Electron IPC boundary (safe integers become numbers; larger values and
dates become strings), so results are identical in local and remote
execution.

## Known limits

- One dataset at a time: commands operate on the base query of the
  current view (pivots do not affect command results).
- DECIMAL columns are summarized in double precision.
- `tab` is one-way only (no two-way tables, no `, missing` option).
- The expression grammar has no arithmetic, no functions beyond
  `date(...)`, and no implicit `x != 0` boolean coercion.
