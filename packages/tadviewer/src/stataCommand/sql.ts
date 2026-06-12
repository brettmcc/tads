/**
 * Query planning and SQL generation for resolved Stata commands.
 *
 * - browse compiles to a reltab FilterExp + projected column list (the
 *   main grid consumes those), plus the canonical generated SQL of the
 *   filtered/projected query for display.
 * - summarize / tabulate / codebook compile to DuckDB SQL strings that
 *   are executed through the read-only SQL API. Every plan retains the
 *   exact SQL that will be executed.
 *
 * Documented semantics:
 * - summarize: one row per requested variable, in command order. For
 *   numeric variables: N (non-null), mean, sd (stddev_samp), min, max,
 *   all cast to DOUBLE. For non-numeric variables (strings, booleans,
 *   dates, blobs): N is reported and the numeric statistics are NULL
 *   (rendered blank).
 * - tabulate: frequency, percent, and cumulative percent per distinct
 *   non-null value, sorted ascending by value. NULL is excluded, like
 *   simple Stata `tab`; percents are relative to non-null filtered rows.
 *   Window functions compute the total and cumulative sums; an empty
 *   input yields an empty result (no division by zero).
 * - codebook: per variable, SQL type (from the schema), N, missing,
 *   distinct count (exact COUNT(DISTINCT ...)), then min/max for ordered
 *   (numeric and date/timestamp) variables or the top values by
 *   frequency for other variables. Top values are limited to
 *   TOP_VALUES_LIMIT rows with ties broken by value ascending.
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

export interface PlanContext {
  /** schema of the data columns of the current view (no synthetic columns) */
  schema: Schema;
  dialect: SQLDialect;
  /** the current view's base query (the loaded dataset) */
  baseQuery: QueryExp;
}

export interface BrowsePlan {
  kind: "browse";
  columns: string[];
  filterExp: FilterExp | null;
  sql: string;
}

export interface SummarizePlan {
  kind: "summarize";
  variables: string[];
  /** single wide aggregate query; one scan regardless of variable count */
  sql: string;
}

export interface TabulatePlan {
  kind: "tabulate";
  variable: string;
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

export type CommandPlan =
  | BrowsePlan
  | SummarizePlan
  | TabulatePlan
  | CodebookPlan;

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

/* --------------- compilation to reltab FilterExp (browse) -------------- */

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

function planBrowse(
  cmd: StataCommand & { kind: "browse" },
  ctx: PlanContext
): BrowsePlan {
  const filterExp = cmd.filter === undefined ? null : exprToFilterExp(cmd.filter);
  let query = ctx.baseQuery;
  if (filterExp !== null) {
    query = query.filter(filterExp);
  }
  query = query.project(cmd.variables);
  const tableMap = mkTableMap(query, ctx.schema);
  const sql = query.toSql(ctx.dialect, tableMap);
  return { kind: "browse", columns: cmd.variables, filterExp, sql };
}

function whereClause(
  filter: Expr | undefined,
  ctx: PlanContext,
  extraCondition?: string
): string {
  const parts: string[] = [];
  if (filter !== undefined) {
    parts.push(`(${exprToSqlWhere(filter, ctx.dialect)})`);
  }
  if (extraCondition !== undefined) {
    parts.push(extraCondition);
  }
  return parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;
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

function planTabulate(
  cmd: StataCommand & { kind: "tabulate" },
  ctx: PlanContext
): TabulatePlan {
  const q = ctx.dialect.quoteCol(cmd.variable);
  const from = fromClause(ctx);
  const where = whereClause(cmd.filter, ctx, `${q} IS NOT NULL`);
  const lines = [
    `SELECT CAST(${q} AS VARCHAR) AS value,`,
    `       count(*) AS freq,`,
    `       100.0 * count(*) / sum(count(*)) OVER () AS percent,`,
    `       100.0 * sum(count(*)) OVER (ORDER BY ${q}) / sum(count(*)) OVER () AS cum_percent,`,
    `       count(*) OVER () AS n_groups`,
    from,
    where,
    `GROUP BY ${q}`,
    `ORDER BY ${q}`,
    `LIMIT ${TAB_GROUP_LIMIT}`,
  ];
  return { kind: "tabulate", variable: cmd.variable, sql: lines.join("\n") };
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
    const topValuesSql = [
      `SELECT CAST(${q} AS VARCHAR) AS value,`,
      `       count(*) AS freq`,
      from,
      `WHERE ${q} IS NOT NULL`,
      `GROUP BY ${q}`,
      `ORDER BY freq DESC, value ASC`,
      `LIMIT ${TOP_VALUES_LIMIT}`,
    ].join("\n");
    return { variable: colId, sqlType, ordered, topValuesSql };
  });
  const statsSql = [
    "SELECT " + statCols[0] + ",",
    ...statCols
      .slice(1)
      .map((s, i) => `       ${s}${i === statCols.length - 2 ? "" : ","}`),
    from,
  ].join("\n");
  return { kind: "codebook", statsSql, variables };
}

/**
 * Plan a resolved command against the current view. Pure: no database
 * access. The returned plan retains the exact SQL to be executed (or,
 * for browse, displayed).
 */
export function planCommand(cmd: StataCommand, ctx: PlanContext): CommandPlan {
  switch (cmd.kind) {
    case "browse":
      return planBrowse(cmd, ctx);
    case "summarize":
      return planSummarize(cmd, ctx);
    case "tabulate":
      return planTabulate(cmd, ctx);
    case "codebook":
      return planCodebook(cmd, ctx);
  }
}
