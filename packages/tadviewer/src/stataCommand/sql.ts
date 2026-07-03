/**
 * Query planning and SQL generation for resolved Stata commands.
 *
 * - browse / keep / drop / order / sort / gsort change the main grid
 *   (projection, row filter, sort order); their plans carry the new view
 *   state plus the canonical SQL of the resulting view for display.
 * - summarize / tabulate / codebook / count / list / describe /
 *   histogram compile to DuckDB SQL executed through the read-only SQL
 *   API. Every plan retains the exact SQL that will be executed.
 *
 * Session semantics: the "dataset" a command sees is the current view --
 * the visible columns (after keep/drop/order or UI changes) and the
 * accumulated keep-if/drop-if row filter (ctx.sessionFilter). Stats
 * commands combine the session filter with their own `if` clause.
 * Unlike Stata, null never satisfies a comparison (Stata treats missing
 * as +infinity); null handling is explicit via `== null` / `!= null`.
 *
 * Documented semantics:
 * - summarize: one row per requested variable, in command order. For
 *   numeric variables: N (non-null), mean, sd (stddev_samp), min, max,
 *   all cast to DOUBLE, computed in a single scan. Non-numeric
 *   variables report N with blank statistics.
 * - summarize, detail: per numeric variable, Stata's detail panel:
 *   exact percentiles using Stata's order-statistic definition
 *   (average of adjacent order stats when N*p is an integer), the four
 *   smallest/largest values, N, sum, mean, sd, variance (sample), and
 *   skewness/kurtosis using Stata's population-moment definitions.
 * - tabulate: frequency, percent, and cumulative percent per distinct
 *   value, sorted ascending, capped at TAB_GROUP_LIMIT values. NULL is
 *   excluded unless the `missing` option is given (then it sorts last
 *   and displays as ".").
 * - codebook: per variable, SQL type, N, missing, exact distinct, then
 *   min/max (ordered types) or top values (TOP_VALUES_LIMIT, ties by
 *   value) -- all scalar stats in one scan.
 * - count: number of rows matching the session + if filters.
 * - list: first LIST_LIMIT matching rows of the requested columns.
 * - describe: variable names and SQL types plus the observation count.
 * - histogram: frequency histogram of a numeric variable; default bin
 *   count is Stata's min(sqrt(N), 10*log10(N)).
 */

import {
  BinRelExp,
  col,
  colIsNumeric,
  ColumnType,
  constVal,
  FilterExp,
  QueryExp,
  Schema,
  SQLDialect,
  SubExp,
  UnaryRelExp,
} from "reltab";
import { CmpOp, Expr, Literal, Operand, StataCommand } from "./ast";
import { StataCommandError } from "./errors";

export const TOP_VALUES_LIMIT = 10;

/**
 * Maximum number of distinct values a tabulate result will return.
 * Percent and cumulative percent are computed over all groups before the
 * limit is applied; the executor reports the total group count so the UI
 * can indicate truncation.
 */
export const TAB_GROUP_LIMIT = 1000;

/** maximum rows returned by the list command */
export const LIST_LIMIT = 200;

/** percentiles reported by summarize, detail (Stata's set) */
export const DETAIL_PERCENTILES = [1, 5, 10, 25, 50, 75, 90, 95, 99];

/* ----------------------- filter expression utils ---------------------- */

/** AND-combine two optional filters, flattening nested ANDs */
export function combineFilters(
  a: Expr | null | undefined,
  b: Expr | null | undefined
): Expr | undefined {
  const parts: Expr[] = [];
  for (const e of [a, b]) {
    if (e != null) {
      if (e.kind === "and") {
        parts.push(...e.args);
      } else {
        parts.push(e);
      }
    }
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { kind: "and", args: parts };
}

const NEGATED_OP: { [op in CmpOp]: CmpOp } = {
  "==": "!=",
  "!=": "==",
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
};

/**
 * Logical negation of a filter (used by `drop if`). Note SQL semantics:
 * rows where a compared value is null satisfy neither a comparison nor
 * its negation, so `drop if x > 2` also drops rows with null x only via
 * the explicit `!= null` form.
 */
export function negateExpr(e: Expr): Expr {
  switch (e.kind) {
    case "cmp":
      return { kind: "cmp", op: NEGATED_OP[e.op], lhs: e.lhs, rhs: e.rhs };
    case "and":
      return { kind: "or", args: e.args.map(negateExpr) };
    case "or":
      return { kind: "and", args: e.args.map(negateExpr) };
  }
}

/* ------------------------------ contexts ------------------------------ */

export interface PlanContext {
  /**
   * schema of the session dataset: the current view's visible data
   * columns, in display order (no synthetic columns)
   */
  schema: Schema;
  dialect: SQLDialect;
  /** the current view's base query (the loaded dataset) */
  baseQuery: QueryExp;
  /** accumulated keep-if/drop-if dataset filter */
  sessionFilter?: Expr | null;
  /** current grid sort key (for grid-op plans) */
  sortKey?: Array<[string, boolean]>;
}

export interface BrowsePlan {
  kind: "browse";
  columns: string[];
  /** combined session + browse filter, compiled for the grid */
  filterExp: FilterExp | null;
  sql: string;
}

export interface SummarizePlan {
  kind: "summarize";
  variables: string[];
  /** single wide aggregate query; one scan regardless of variable count */
  sql: string;
}

export interface SumDetailPlan {
  kind: "sumDetail";
  /** numeric variables only, in command order */
  variables: string[];
  /** non-numeric variables requested but omitted from the detail panels */
  skipped: string[];
  /** phase 1: N and mean for every variable in one scan */
  phase1Sql: string;
  /**
   * phase 2 (per variable, given N and mean from phase 1): percentiles,
   * extremes, moments. Pure function of the plan; the executor invokes
   * it once the counts are known.
   */
  mkDetailSql(variable: string, n: number, mean: number): string;
}

export interface TabulatePlan {
  kind: "tabulate";
  variable: string;
  missing: boolean;
  sql: string;
}

export interface CodebookVarPlan {
  variable: string;
  sqlType: string;
  /** ordered variables report min/max; others report top values */
  ordered: boolean;
  topValuesSql?: string;
}

export interface CodebookPlan {
  kind: "codebook";
  /** one wide aggregate query covering every requested variable */
  statsSql: string;
  variables: CodebookVarPlan[];
}

export interface CountPlan {
  kind: "count";
  sql: string;
}

export interface ListPlan {
  kind: "list";
  variables: string[];
  sql: string;
}

export interface DescribePlan {
  kind: "describe";
  variables: Array<{ name: string; sqlType: string }>;
  countSql: string;
}

export interface DsPlan {
  kind: "ds";
  variables: string[];
}

export interface GridPlan {
  kind: "grid";
  op: "keep" | "drop" | "order" | "sort" | "gsort";
  displayColumns: string[];
  sortKey: Array<[string, boolean]>;
  /** new session filter; only meaningful when sessionChanged */
  sessionFilter: Expr | null;
  sessionChanged: boolean;
  /** compiled grid filter for the new session (when sessionChanged) */
  gridFilterExp: FilterExp | null;
  /** canonical SQL of the resulting view */
  sql: string;
  /** human-readable summary for the results log */
  note: string;
}

export interface HistogramPlan {
  kind: "histogram";
  variable: string;
  requestedBins?: number;
  /** phase 1: N, min, max of the variable under the filters */
  statsSql: string;
  /** phase 2: binned frequencies given the layout from phase 1 */
  mkBinsSql(minVal: number, binWidth: number, binCount: number): string;
}

export type CommandPlan =
  | BrowsePlan
  | SummarizePlan
  | SumDetailPlan
  | TabulatePlan
  | CodebookPlan
  | CountPlan
  | ListPlan
  | DescribePlan
  | DsPlan
  | GridPlan
  | HistogramPlan;

/* ----------------- SQL literal / expression rendering ----------------- */

/**
 * Render a string as a SQL string literal: single quotes doubled, all
 * other characters (including double quotes and backslashes) untouched.
 */
export function sqlStringLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new StataCommandError("parse", `non-finite number ${value}`);
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function dateLiteral(lit: { value: string; hasTime: boolean }): string {
  if (lit.hasTime) {
    return `TIMESTAMP '${lit.value.replace("T", " ")}'`;
  }
  return `DATE '${lit.value}'`;
}

function literalToSql(lit: Literal): string {
  switch (lit.kind) {
    case "number":
      return numberLiteral(lit.value);
    case "string":
      return sqlStringLiteral(lit.value);
    case "date":
      return dateLiteral(lit);
    case "null":
      return "NULL";
  }
}

function operandToSql(op: Operand, quoteCol: (c: string) => string): string {
  if (op.kind === "var") {
    return quoteCol(op.name);
  }
  return literalToSql(op);
}

const CMP_SQL: { [op in CmpOp]: string } = {
  "==": "=",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

/**
 * Render a resolved filter expression as a SQL boolean expression using
 * the dialect's identifier quoting. Null comparisons become IS NULL /
 * IS NOT NULL.
 */
export function exprToSqlWhere(expr: Expr, dialect: SQLDialect): string {
  const quoteCol = (c: string) => dialect.quoteCol(c);

  const render = (e: Expr): string => {
    switch (e.kind) {
      case "cmp": {
        const lhsNull = e.lhs.kind === "null";
        const rhsNull = e.rhs.kind === "null";
        if (lhsNull || rhsNull) {
          const subject = lhsNull ? e.rhs : e.lhs;
          const subjectSql = operandToSql(subject, quoteCol);
          return e.op === "=="
            ? `${subjectSql} IS NULL`
            : `${subjectSql} IS NOT NULL`;
        }
        return `${operandToSql(e.lhs, quoteCol)} ${CMP_SQL[e.op]} ${operandToSql(
          e.rhs,
          quoteCol
        )}`;
      }
      case "and":
        return e.args.map(renderChild).join(" AND ");
      case "or":
        return e.args.map(renderChild).join(" OR ");
    }
  };

  const renderChild = (e: Expr): string => {
    const s = render(e);
    return e.kind === "cmp" ? s : `(${s})`;
  };

  return render(expr);
}

/* --------------- compilation to reltab FilterExp (grid) --------------- */

function operandToValExp(op: Operand) {
  switch (op.kind) {
    case "var":
      return col(op.name);
    case "number":
      return constVal(op.value);
    case "string":
      return constVal(op.value);
    case "date":
      // rely on the SQL engine's implicit cast of the ISO string when
      // compared against a date/timestamp column
      return constVal(lit2DateString(op));
    case "null":
      return constVal(null);
  }
}

function lit2DateString(lit: { value: string; hasTime: boolean }): string {
  return lit.hasTime ? lit.value.replace("T", " ") : lit.value;
}

const CMP_RELOP: { [op in CmpOp]: "EQ" | "NEQ" | "LT" | "LE" | "GT" | "GE" } =
  {
    "==": "EQ",
    "!=": "NEQ",
    "<": "LT",
    "<=": "LE",
    ">": "GT",
    ">=": "GE",
  };

/**
 * Compile a resolved filter expression to a reltab FilterExp for use as
 * the main grid's view filter.
 */
export function exprToFilterExp(expr: Expr): FilterExp {
  const toSub = (e: Expr): SubExp => {
    switch (e.kind) {
      case "cmp": {
        const lhsNull = e.lhs.kind === "null";
        const rhsNull = e.rhs.kind === "null";
        if (lhsNull || rhsNull) {
          const subject = lhsNull ? e.rhs : e.lhs;
          return new UnaryRelExp(
            e.op === "==" ? "ISNULL" : "NOTNULL",
            operandToValExp(subject)
          );
        }
        return new BinRelExp(
          CMP_RELOP[e.op],
          operandToValExp(e.lhs),
          operandToValExp(e.rhs)
        );
      }
      case "and":
        return new FilterExp("AND", e.args.map(toSub));
      case "or":
        return new FilterExp("OR", e.args.map(toSub));
    }
  };

  const sub = toSub(expr);
  if (sub instanceof FilterExp) {
    return sub;
  }
  return new FilterExp("AND", [sub]);
}

/* ----------------------------- planning ------------------------------- */

/**
 * Build a LeafSchemaMap mapping every leaf dependency of the query to
 * the base schema. Commands only ever reference the single base query
 * of the current view, so this is exact.
 */
function mkTableMap(query: QueryExp, schema: Schema): { [k: string]: Schema } {
  const tableMap: { [k: string]: Schema } = {};
  for (const key of query.getLeafDeps().keys()) {
    tableMap[key] = schema;
  }
  return tableMap;
}

/** SQL text of the current view's base query, used as the FROM source. */
export function baseQuerySql(ctx: PlanContext): string {
  const tableMap = mkTableMap(ctx.baseQuery, ctx.schema);
  return ctx.baseQuery.toSql(ctx.dialect, tableMap);
}

function fromClause(ctx: PlanContext): string {
  const baseSql = baseQuerySql(ctx).trimEnd();
  const indented = baseSql
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
  return `FROM (\n${indented}\n)`;
}

function columnTypeOf(ctx: PlanContext, colId: string): ColumnType {
  return ctx.schema.columnType(colId);
}

function isOrderedType(ct: ColumnType): boolean {
  return colIsNumeric(ct) || ct.kind === "timestamp";
}

/**
 * WHERE clause combining the session filter, the command's if clause,
 * and an optional extra condition.
 */
function whereClause(
  filter: Expr | undefined,
  ctx: PlanContext,
  extraCondition?: string
): string {
  const combined = combineFilters(ctx.sessionFilter ?? undefined, filter);
  const parts: string[] = [];
  if (combined !== undefined) {
    parts.push(`(${exprToSqlWhere(combined, ctx.dialect)})`);
  }
  if (extraCondition !== undefined) {
    parts.push(extraCondition);
  }
  return parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;
}

/** canonical SQL of a view: filter + projection + sort over the base */
function viewSql(
  ctx: PlanContext,
  displayColumns: string[],
  filter: Expr | undefined,
  sortKey: Array<[string, boolean]>
): string {
  let query = ctx.baseQuery;
  if (filter !== undefined) {
    query = query.filter(exprToFilterExp(filter));
  }
  query = query.project(displayColumns);
  if (sortKey.length > 0) {
    query = query.sort(sortKey);
  }
  return query.toSql(ctx.dialect, mkTableMap(query, ctx.schema));
}

function planBrowse(
  cmd: StataCommand & { kind: "browse" },
  ctx: PlanContext
): BrowsePlan {
  const combined = combineFilters(ctx.sessionFilter ?? undefined, cmd.filter);
  const filterExp = combined === undefined ? null : exprToFilterExp(combined);
  let query = ctx.baseQuery;
  if (filterExp !== null) {
    query = query.filter(filterExp);
  }
  query = query.project(cmd.variables);
  const tableMap = mkTableMap(query, ctx.schema);
  const sql = query.toSql(ctx.dialect, tableMap);
  return { kind: "browse", columns: cmd.variables, filterExp, sql };
}

/**
 * Summarize compiles to a single wide aggregate row computed in one scan
 * (per-variable stat columns suffixed _0, _1, ...); the executor reshapes
 * it into one output row per variable.
 */
function planSummarize(
  cmd: StataCommand & { kind: "summarize" },
  ctx: PlanContext
): SummarizePlan {
  const from = fromClause(ctx);
  const where = whereClause(cmd.filter, ctx);
  const statCols: string[] = [];
  cmd.variables.forEach((colId, idx) => {
    const q = ctx.dialect.quoteCol(colId);
    const ct = columnTypeOf(ctx, colId);
    const numeric = colIsNumeric(ct);
    statCols.push(`count(${q}) AS n_${idx}`);
    if (numeric) {
      statCols.push(
        `CAST(avg(${q}) AS DOUBLE) AS mean_${idx}`,
        `CAST(stddev_samp(${q}) AS DOUBLE) AS sd_${idx}`,
        `CAST(min(${q}) AS DOUBLE) AS min_${idx}`,
        `CAST(max(${q}) AS DOUBLE) AS max_${idx}`
      );
    } else {
      statCols.push(
        `CAST(NULL AS DOUBLE) AS mean_${idx}`,
        `CAST(NULL AS DOUBLE) AS sd_${idx}`,
        `CAST(NULL AS DOUBLE) AS min_${idx}`,
        `CAST(NULL AS DOUBLE) AS max_${idx}`
      );
    }
  });
  const lines = [
    "SELECT " + statCols[0] + ",",
    ...statCols
      .slice(1)
      .map((s, i) => `       ${s}${i === statCols.length - 2 ? "" : ","}`),
    from,
  ];
  if (where !== "") {
    lines.push(where);
  }
  return {
    kind: "summarize",
    variables: cmd.variables,
    sql: lines.join("\n"),
  };
}

/**
 * The k-th order statistic of a column, exact and robust: DuckDB's
 * quantile_disc(x, p) returns x_(ceil(p*N)), so p = (k - 0.5)/N always
 * lands on x_(k) regardless of floating-point rounding.
 */
function orderStatSql(q: string, k: number, n: number): string {
  return `quantile_disc(${q}, ${(k - 0.5) / n})`;
}

/**
 * Stata percentile definition (summarize, detail): with h = N*p/100,
 * the percentile is x_(ceil(h)) when h is not an integer, and the
 * average of x_(h) and x_(h+1) when it is.
 */
function stataPercentileSql(q: string, p: number, n: number): string {
  const h100 = n * p; // h = h100 / 100
  if (h100 % 100 === 0) {
    const h = h100 / 100;
    return `(${orderStatSql(q, h, n)} + ${orderStatSql(q, h + 1, n)}) / 2.0`;
  }
  const k = Math.ceil(h100 / 100);
  return orderStatSql(q, k, n);
}

function planSumDetail(
  cmd: StataCommand & { kind: "summarize" },
  ctx: PlanContext
): SumDetailPlan {
  // detail panels apply to numeric variables only
  const explicit = cmd.variables.filter((colId) =>
    colIsNumeric(columnTypeOf(ctx, colId))
  );
  const skipped = cmd.variables.filter(
    (colId) => !colIsNumeric(columnTypeOf(ctx, colId))
  );
  if (explicit.length === 0) {
    throw new StataCommandError(
      "plan",
      "summarize, detail requires at least one numeric variable"
    );
  }
  const from = fromClause(ctx);
  const where = whereClause(cmd.filter, ctx);
  const dialect = ctx.dialect;

  const phase1Cols = explicit.flatMap((colId, idx) => {
    const q = dialect.quoteCol(colId);
    return [
      `count(${q}) AS n_${idx}`,
      `CAST(avg(${q}) AS DOUBLE) AS mean_${idx}`,
    ];
  });
  const phase1Lines = [
    "SELECT " + phase1Cols[0] + ",",
    ...phase1Cols
      .slice(1)
      .map((s, i) => `       ${s}${i === phase1Cols.length - 2 ? "" : ","}`),
    from,
  ];
  if (where !== "") {
    phase1Lines.push(where);
  }

  const mkDetailSql = (variable: string, n: number, mean: number): string => {
    const q = dialect.quoteCol(variable);
    const meanLit = numberLiteral(mean);
    const cols: string[] = [];
    for (const p of DETAIL_PERCENTILES) {
      cols.push(
        `CAST(${stataPercentileSql(q, p, n)} AS DOUBLE) AS p${p}`
      );
    }
    const nSmall = Math.min(4, n);
    for (let k = 1; k <= nSmall; k++) {
      cols.push(`CAST(${orderStatSql(q, k, n)} AS DOUBLE) AS small_${k}`);
    }
    for (let i = 0; i < Math.min(4, n); i++) {
      const k = n - i;
      cols.push(
        `CAST(${orderStatSql(q, k, n)} AS DOUBLE) AS large_${i + 1}`
      );
    }
    cols.push(
      `CAST(sum(${q}) AS DOUBLE) AS sum`,
      `CAST(stddev_samp(${q}) AS DOUBLE) AS sd`,
      `CAST(var_samp(${q}) AS DOUBLE) AS variance`,
      // central moments about the phase-1 mean, for Stata's
      // population-moment skewness (m3/m2^1.5) and kurtosis (m4/m2^2)
      `CAST(avg(pow(${q} - ${meanLit}, 2)) AS DOUBLE) AS m2`,
      `CAST(avg(pow(${q} - ${meanLit}, 3)) AS DOUBLE) AS m3`,
      `CAST(avg(pow(${q} - ${meanLit}, 4)) AS DOUBLE) AS m4`
    );
    const lines = [
      "SELECT " + cols[0] + ",",
      ...cols
        .slice(1)
        .map((s, i) => `       ${s}${i === cols.length - 2 ? "" : ","}`),
      from,
    ];
    if (where !== "") {
      lines.push(where);
    }
    return lines.join("\n");
  };

  return {
    kind: "sumDetail",
    variables: explicit,
    skipped,
    phase1Sql: phase1Lines.join("\n"),
    mkDetailSql,
  };
}

function planTabulate(
  cmd: StataCommand & { kind: "tabulate" },
  ctx: PlanContext
): TabulatePlan {
  const q = ctx.dialect.quoteCol(cmd.variable);
  const from = fromClause(ctx);
  const where = whereClause(
    cmd.filter,
    ctx,
    cmd.missing ? undefined : `${q} IS NOT NULL`
  );
  const lines = [
    `SELECT CAST(${q} AS VARCHAR) AS value,`,
    `       count(*) AS freq,`,
    `       100.0 * count(*) / sum(count(*)) OVER () AS percent,`,
    `       100.0 * sum(count(*)) OVER (ORDER BY ${q}) / sum(count(*)) OVER () AS cum_percent,`,
    `       count(*) OVER () AS n_groups`,
    from,
  ];
  if (where !== "") {
    lines.push(where);
  }
  lines.push(`GROUP BY ${q}`, `ORDER BY ${q}`, `LIMIT ${TAB_GROUP_LIMIT}`);
  return {
    kind: "tabulate",
    variable: cmd.variable,
    missing: cmd.missing,
    sql: lines.join("\n"),
  };
}

/**
 * Codebook computes N / missing / distinct / min / max for all requested
 * variables in one scan (stat columns suffixed by variable index); the
 * per-variable top-values queries (categorical variables only) remain
 * separate and are executed concurrently by the executor.
 */
function planCodebook(
  cmd: StataCommand & { kind: "codebook" },
  ctx: PlanContext
): CodebookPlan {
  const from = fromClause(ctx);
  const where = whereClause(undefined, ctx);
  const statCols: string[] = [];
  const variables = cmd.variables.map((colId, idx): CodebookVarPlan => {
    const q = ctx.dialect.quoteCol(colId);
    const ct = columnTypeOf(ctx, colId);
    const ordered = isOrderedType(ct);
    const sqlType = ctx.schema.columnMetadata[colId].columnType;
    statCols.push(
      `count(${q}) AS n_${idx}`,
      `count(*) - count(${q}) AS missing_${idx}`,
      `count(DISTINCT ${q}) AS distinct_${idx}`
    );
    if (ordered) {
      statCols.push(
        `CAST(min(${q}) AS VARCHAR) AS min_${idx}`,
        `CAST(max(${q}) AS VARCHAR) AS max_${idx}`
      );
    } else {
      statCols.push(
        `CAST(NULL AS VARCHAR) AS min_${idx}`,
        `CAST(NULL AS VARCHAR) AS max_${idx}`
      );
    }
    if (ordered) {
      return { variable: colId, sqlType, ordered };
    }
    const topLines = [
      `SELECT CAST(${q} AS VARCHAR) AS value,`,
      `       count(*) AS freq`,
      from,
    ];
    const topWhere = whereClause(undefined, ctx, `${q} IS NOT NULL`);
    if (topWhere !== "") {
      topLines.push(topWhere);
    }
    topLines.push(
      `GROUP BY ${q}`,
      `ORDER BY freq DESC, value ASC`,
      `LIMIT ${TOP_VALUES_LIMIT}`
    );
    return {
      variable: colId,
      sqlType,
      ordered,
      topValuesSql: topLines.join("\n"),
    };
  });
  const statsLines = [
    "SELECT " + statCols[0] + ",",
    ...statCols
      .slice(1)
      .map((s, i) => `       ${s}${i === statCols.length - 2 ? "" : ","}`),
    from,
  ];
  if (where !== "") {
    statsLines.push(where);
  }
  return { kind: "codebook", statsSql: statsLines.join("\n"), variables };
}

function planCount(
  cmd: StataCommand & { kind: "count" },
  ctx: PlanContext
): CountPlan {
  const lines = [`SELECT count(*) AS n`, fromClause(ctx)];
  const where = whereClause(cmd.filter, ctx);
  if (where !== "") {
    lines.push(where);
  }
  return { kind: "count", sql: lines.join("\n") };
}

function planList(
  cmd: StataCommand & { kind: "list" },
  ctx: PlanContext
): ListPlan {
  const cols = cmd.variables.map((c) => ctx.dialect.quoteCol(c));
  const lines = [
    `SELECT ${cols.join(", ")},`,
    `       count(*) OVER () AS n_total`,
    fromClause(ctx),
  ];
  const where = whereClause(cmd.filter, ctx);
  if (where !== "") {
    lines.push(where);
  }
  // Without an ORDER BY, DuckDB's parallel scan can return a different
  // subset/order of rows on each run. Respect the grid's current sort,
  // falling back to the listed columns themselves for a deterministic
  // default.
  const sortKey = currentSortKey(ctx);
  const orderTerms =
    sortKey.length > 0
      ? sortKey.map(
          ([c, asc]) => `${ctx.dialect.quoteCol(c)}${asc ? "" : " DESC"}`
        )
      : cols;
  lines.push(`ORDER BY ${orderTerms.join(", ")}`);
  lines.push(`LIMIT ${LIST_LIMIT}`);
  return { kind: "list", variables: cmd.variables, sql: lines.join("\n") };
}

function planDescribe(
  cmd: StataCommand & { kind: "describe" },
  ctx: PlanContext
): DescribePlan {
  const variables = cmd.variables.map((name) => ({
    name,
    sqlType: ctx.schema.columnMetadata[name].columnType,
  }));
  const lines = [`SELECT count(*) AS n`, fromClause(ctx)];
  const where = whereClause(undefined, ctx);
  if (where !== "") {
    lines.push(where);
  }
  return { kind: "describe", variables, countSql: lines.join("\n") };
}

function planHistogram(
  cmd: StataCommand & { kind: "histogram" },
  ctx: PlanContext
): HistogramPlan {
  const ct = columnTypeOf(ctx, cmd.variable);
  if (!colIsNumeric(ct)) {
    throw new StataCommandError(
      "plan",
      `histogram requires a numeric variable ('${cmd.variable}' is ${
        ctx.schema.columnMetadata[cmd.variable].columnType
      })`
    );
  }
  const q = ctx.dialect.quoteCol(cmd.variable);
  const from = fromClause(ctx);
  const where = whereClause(cmd.filter, ctx, `${q} IS NOT NULL`);

  const statsLines = [
    `SELECT count(${q}) AS n,`,
    `       CAST(min(${q}) AS DOUBLE) AS min,`,
    `       CAST(max(${q}) AS DOUBLE) AS max`,
    from,
    where,
  ];

  const mkBinsSql = (
    minVal: number,
    binWidth: number,
    binCount: number
  ): string => {
    if (binCount <= 1 || binWidth <= 0) {
      return [`SELECT 0 AS bin, count(*) AS freq`, from, where].join("\n");
    }
    const minLit = numberLiteral(minVal);
    const widthLit = numberLiteral(binWidth);
    return [
      `SELECT LEAST(CAST(floor((${q} - ${minLit}) / ${widthLit}) AS INTEGER), ${
        binCount - 1
      }) AS bin,`,
      `       count(*) AS freq`,
      from,
      where,
      `GROUP BY bin`,
      `ORDER BY bin`,
    ].join("\n");
  };

  const plan: HistogramPlan = {
    kind: "histogram",
    variable: cmd.variable,
    statsSql: statsLines.join("\n"),
    mkBinsSql,
  };
  if (cmd.bins !== undefined) {
    plan.requestedBins = cmd.bins;
  }
  return plan;
}

/** Stata's default histogram bin count: min(sqrt(N), 10*log10(N)) */
export function defaultHistogramBins(n: number): number {
  if (n <= 1) return 1;
  return Math.max(
    1,
    Math.round(Math.min(Math.sqrt(n), 10 * Math.log10(n)))
  );
}

/* ------------------------- grid-state planning ------------------------ */

function currentSortKey(ctx: PlanContext): Array<[string, boolean]> {
  return ctx.sortKey === undefined ? [] : ctx.sortKey.slice();
}

function pruneSortKey(
  sortKey: Array<[string, boolean]>,
  columns: string[]
): Array<[string, boolean]> {
  const colSet = new Set(columns);
  return sortKey.filter(([colId]) => colSet.has(colId));
}

function mkGridPlan(
  op: GridPlan["op"],
  ctx: PlanContext,
  displayColumns: string[],
  sortKey: Array<[string, boolean]>,
  sessionFilter: Expr | null,
  sessionChanged: boolean,
  note: string
): GridPlan {
  const gridFilterExp =
    sessionFilter === null ? null : exprToFilterExp(sessionFilter);
  const sql = viewSql(
    ctx,
    displayColumns,
    sessionFilter ?? undefined,
    sortKey
  );
  return {
    kind: "grid",
    op,
    displayColumns,
    sortKey,
    sessionFilter,
    sessionChanged,
    gridFilterExp,
    sql,
    note,
  };
}

function planKeepDrop(
  cmd: StataCommand & { kind: "keep" | "drop" },
  ctx: PlanContext
): GridPlan {
  const current = ctx.schema.columns;
  const session = ctx.sessionFilter ?? null;
  if (cmd.filter !== undefined) {
    const addition =
      cmd.kind === "keep" ? cmd.filter : negateExpr(cmd.filter);
    const newSession = combineFilters(session, addition) ?? null;
    return mkGridPlan(
      cmd.kind,
      ctx,
      current,
      currentSortKey(ctx),
      newSession,
      true,
      `${cmd.kind} if: dataset filter updated`
    );
  }
  const chosen = new Set(cmd.variables);
  const display =
    cmd.kind === "keep"
      ? current.filter((c) => chosen.has(c))
      : current.filter((c) => !chosen.has(c));
  if (display.length === 0) {
    throw new StataCommandError(
      "plan",
      `${cmd.kind} would remove every variable from the view`
    );
  }
  return mkGridPlan(
    cmd.kind,
    ctx,
    display,
    pruneSortKey(currentSortKey(ctx), display),
    session,
    false,
    `${cmd.kind}: ${display.length} of ${current.length} variables now shown`
  );
}

function planOrder(
  cmd: StataCommand & { kind: "order" },
  ctx: PlanContext
): GridPlan {
  const current = ctx.schema.columns;
  const listed = new Set(cmd.variables);
  const rest = current.filter((c) => !listed.has(c));
  const display = cmd.last
    ? [...rest, ...cmd.variables]
    : [...cmd.variables, ...rest];
  return mkGridPlan(
    "order",
    ctx,
    display,
    currentSortKey(ctx),
    ctx.sessionFilter ?? null,
    false,
    `order: ${cmd.variables.join(", ")} moved to ${
      cmd.last ? "end" : "front"
    }`
  );
}

function planSort(
  cmd: StataCommand & { kind: "sort" | "gsort" },
  ctx: PlanContext
): GridPlan {
  const sortKey: Array<[string, boolean]> =
    cmd.kind === "sort"
      ? cmd.variables.map((v): [string, boolean] => [v, true])
      : cmd.keys.map((k): [string, boolean] => [k.name, !k.descending]);
  const keyDesc = sortKey
    .map(([colId, asc]) => `${asc ? "" : "-"}${colId}`)
    .join(" ");
  return mkGridPlan(
    cmd.kind,
    ctx,
    ctx.schema.columns,
    sortKey,
    ctx.sessionFilter ?? null,
    false,
    `${cmd.kind}: ${keyDesc}`
  );
}

/**
 * Plan a resolved command against the current view. Pure: no database
 * access. The returned plan retains the exact SQL to be executed (or,
 * for grid commands, displayed).
 */
export function planCommand(cmd: StataCommand, ctx: PlanContext): CommandPlan {
  switch (cmd.kind) {
    case "browse":
      return planBrowse(cmd, ctx);
    case "summarize":
      return cmd.detail ? planSumDetail(cmd, ctx) : planSummarize(cmd, ctx);
    case "tabulate":
      return planTabulate(cmd, ctx);
    case "codebook":
      return planCodebook(cmd, ctx);
    case "count":
      return planCount(cmd, ctx);
    case "list":
      return planList(cmd, ctx);
    case "describe":
      return planDescribe(cmd, ctx);
    case "ds":
      return { kind: "ds", variables: cmd.variables };
    case "keep":
    case "drop":
      return planKeepDrop(cmd, ctx);
    case "order":
      return planOrder(cmd, ctx);
    case "sort":
    case "gsort":
      return planSort(cmd, ctx);
    case "histogram":
      return planHistogram(cmd, ctx);
  }
}
