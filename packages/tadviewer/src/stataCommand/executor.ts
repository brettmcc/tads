/**
 * Command execution: parse -> resolve -> plan -> execute.
 *
 * The executor is decoupled from the UI through CommandExecutionContext:
 * grid commands (browse/keep/drop/order/sort/gsort) hand their new view
 * state to applyGrid, while data commands run their generated SQL
 * through the read-only SQL API and convert rows into renderable
 * ResultBlocks.
 */

import {
  FilterExp,
  QueryExp,
  ReadOnlySqlResult,
  Row,
  Schema,
  SQLDialect,
} from "reltab";
import { CommandKind, Expr } from "./ast";
import { formatCommandError, StataCommandError } from "./errors";
import { parseCommand } from "./parser";
import { resolveCommand } from "./resolve";
import {
  ByGroupsPlan,
  CodebookPlan,
  CorrelatePlan,
  defaultHistogramBins,
  DescribePlan,
  DETAIL_PERCENTILES,
  DistinctPlan,
  DuplicatesPlan,
  GridPlan,
  HistogramPlan,
  ListPlan,
  planCommand,
  SumDetailPlan,
  SummarizePlan,
  TabulatePlan,
} from "./sql";

export type CellValue = string | number | boolean | null;

export type ResultBlock =
  | {
      kind: "table";
      columns: string[];
      /** per-column alignment hint for rendering; defaults to left */
      align: Array<"left" | "right">;
      rows: CellValue[][];
    }
  | { kind: "text"; text: string }
  /** header introducing one group of a by-prefixed command */
  | { kind: "byGroup"; label: string }
  | {
      kind: "codebookVar";
      variable: string;
      sqlType: string;
      n: number;
      missing: number;
      distinct: number;
      /** present for ordered (numeric / date) variables */
      min?: string | null;
      max?: string | null;
      /** present for unordered variables */
      topValues?: Array<{ value: string; freq: number }>;
    }
  | {
      kind: "sumDetail";
      variable: string;
      n: number;
      sum: number | null;
      mean: number | null;
      sd: number | null;
      variance: number | null;
      skewness: number | null;
      kurtosis: number | null;
      percentiles: Array<{ p: number; value: number | null }>;
      smallest: number[];
      largest: number[];
    }
  | {
      kind: "histogram";
      variable: string;
      n: number;
      binStart: number;
      binWidth: number;
      freqs: number[];
    };

/** view-state update applied by grid commands */
export interface GridUpdate {
  displayColumns?: string[];
  sortKey?: Array<[string, boolean]>;
  /** new accumulated keep-if/drop-if filter (only when it changed) */
  sessionFilter?: Expr | null;
  /** compiled grid filter to install (only when provided) */
  gridFilterExp?: FilterExp | null;
  /**
   * new accumulated keep/drop/order variable list (only set by
   * keep/drop/order, never by sort/gsort/browse, which don't change
   * which variables the command session sees)
   */
  sessionColumns?: string[];
}

export interface CommandExecutionContext {
  /** schema of the session dataset: visible data columns in view order */
  schema: Schema;
  dialect: SQLDialect;
  baseQuery: QueryExp;
  /** current grid sort key */
  sortKey: Array<[string, boolean]>;
  /** accumulated keep-if/drop-if dataset filter */
  sessionFilter: Expr | null;
  runReadOnlySql(sql: string): Promise<ReadOnlySqlResult>;
  applyGrid(update: GridUpdate): void | Promise<void>;
}

export interface CommandSuccess {
  status: "ok";
  kind: CommandKind;
  command: string;
  /** exact SQL executed (joined with ";\n\n" when multiple statements) */
  sql: string;
  blocks: ResultBlock[];
}

export interface CommandFailure {
  status: "error";
  command: string;
  error: string;
}

export type CommandOutcome = CommandSuccess | CommandFailure;

/* ------------------------- value coercion ------------------------- */

/**
 * Coerce a value from a read-only SQL result into a CellValue. Counts
 * arrive as numbers (or decimal strings when beyond safe integer range);
 * means etc. as doubles; everything else is stringified.
 */
function asNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

const ok = (
  kind: CommandKind,
  command: string,
  sql: string,
  blocks: ResultBlock[]
): CommandSuccess => ({ status: "ok", kind, command, sql, blocks });

/* --------------------------- execution ---------------------------- */

/* ---------------------------- by groups ---------------------------- */

/** a group's key: its by_i values (VARCHAR, null for missing) */
type GroupKey = Array<string | null>;

function groupKeyOf(row: Row, nVars: number): GroupKey {
  const key: GroupKey = [];
  for (let i = 0; i < nVars; i++) {
    key.push(asString(row[`by_${i}`]));
  }
  return key;
}

/** Stata's group header: "foreign = 1, rep78 = ." */
function byGroupLabel(variables: string[], key: GroupKey): string {
  return variables.map((v, i) => `${v} = ${key[i] ?? "."}`).join(", ");
}

interface ByGroupsResult {
  groups: GroupKey[];
  /** total number of groups, which may exceed groups.length */
  nGroups: number;
  /** the command query's rows, partitioned by group key */
  rowsByGroup: Map<string, Row[]>;
}

/**
 * Run a by-prefixed command's group-list query alongside its grouped
 * query and partition the latter's rows by group.
 */
async function runByGroups(
  by: ByGroupsPlan,
  sql: string,
  ctx: CommandExecutionContext
): Promise<ByGroupsResult> {
  const [groupsRes, res] = await Promise.all([
    ctx.runReadOnlySql(by.groupsSql),
    ctx.runReadOnlySql(sql),
  ]);
  const nVars = by.variables.length;
  const rowsByGroup = new Map<string, Row[]>();
  for (const row of res.rows) {
    const k = JSON.stringify(groupKeyOf(row, nVars));
    const bucket = rowsByGroup.get(k);
    if (bucket === undefined) {
      rowsByGroup.set(k, [row]);
    } else {
      bucket.push(row);
    }
  }
  const groups = groupsRes.rows.map((row: Row) => groupKeyOf(row, nVars));
  const nGroups = asNumber(groupsRes.rows[0]?.n_by_groups) ?? groups.length;
  return { groups, nGroups, rowsByGroup };
}

/**
 * Interleave a header per group with that group's result blocks; a group
 * with no rows (every observation failed the `if`) gets render([]).
 */
function byGroupBlocks(
  by: ByGroupsPlan,
  result: ByGroupsResult,
  render: (rows: Row[]) => ResultBlock[]
): ResultBlock[] {
  return [
    ...result.groups.flatMap((key): ResultBlock[] => [
      { kind: "byGroup", label: byGroupLabel(by.variables, key) },
      ...render(result.rowsByGroup.get(JSON.stringify(key)) ?? []),
    ]),
    ...byTruncationNote(result.groups.length, result.nGroups),
  ];
}

function byTruncationNote(shown: number, total: number): ResultBlock[] {
  return total > shown
    ? [{ kind: "text", text: `showing first ${shown} of ${total} groups` }]
    : [];
}

/**
 * Run a command's query, by group when it has a by prefix: `render` turns
 * the rows of one group (or of the whole query) into result blocks.
 */
async function runMaybeBy(
  plan: { by?: ByGroupsPlan; sql: string },
  ctx: CommandExecutionContext,
  render: (rows: Row[]) => ResultBlock[]
): Promise<{ blocks: ResultBlock[]; sql: string }> {
  if (plan.by === undefined) {
    const res = await ctx.runReadOnlySql(plan.sql);
    return { blocks: render(res.rows), sql: plan.sql };
  }
  const result = await runByGroups(plan.by, plan.sql, ctx);
  return {
    blocks: byGroupBlocks(plan.by, result, render),
    sql: [plan.by.groupsSql, plan.sql].join(";\n\n"),
  };
}

/* ------------------------- per-command output ------------------------- */

function summarizeBlocks(plan: SummarizePlan, rows: Row[]): ResultBlock[] {
  // one wide row of per-variable aggregates; reshape to a row per variable
  // (no row at all for a by group the `if` emptied)
  const wide: Row = rows[0] ?? {};
  const tableRows = plan.variables.map((variable, idx): CellValue[] => {
    if (plan.varKinds[idx] === "date") {
      // mean/min/max arrive as date/timestamp strings; sd is in days
      const sdDays = asNumber(wide[`sd_${idx}`]);
      return [
        variable,
        asNumber(wide[`n_${idx}`]) ?? 0,
        asString(wide[`mean_${idx}`]),
        sdDays === null ? null : `${Number(sdDays.toPrecision(6))} days`,
        asString(wide[`min_${idx}`]),
        asString(wide[`max_${idx}`]),
      ];
    }
    return [
      variable,
      asNumber(wide[`n_${idx}`]) ?? 0,
      asNumber(wide[`mean_${idx}`]),
      asNumber(wide[`sd_${idx}`]),
      asNumber(wide[`min_${idx}`]),
      asNumber(wide[`max_${idx}`]),
    ];
  });
  return [
    {
      kind: "table",
      columns: ["Variable", "N", "Mean", "Std. dev.", "Min", "Max"],
      align: ["left", "right", "right", "right", "right", "right"],
      rows: tableRows,
    },
  ];
}

/**
 * summarize, detail phase 2: one detail panel per variable, given the
 * phase-1 row (N and mean per variable) of the whole session dataset or
 * of one by group (`groupKey`).
 */
async function sumDetailBlocks(
  plan: SumDetailPlan,
  wide: Row,
  ctx: CommandExecutionContext,
  groupKey?: GroupKey
): Promise<{ blocks: ResultBlock[]; sqls: string[] }> {
  const detailJobs = plan.variables.map(async (variable, idx) => {
    const n = asNumber(wide[`n_${idx}`]) ?? 0;
    const mean = asNumber(wide[`mean_${idx}`]);
    if (n === 0 || mean === null) {
      const empty: ResultBlock = {
        kind: "sumDetail",
        variable,
        n: 0,
        sum: null,
        mean: null,
        sd: null,
        variance: null,
        skewness: null,
        kurtosis: null,
        percentiles: DETAIL_PERCENTILES.map((p) => ({ p, value: null })),
        smallest: [],
        largest: [],
      };
      return { block: empty, sql: null as string | null };
    }
    const detailSql = plan.mkDetailSql(variable, n, mean, groupKey);
    const res = await ctx.runReadOnlySql(detailSql);
    const row: Row = res.rows[0] ?? {};
    const m2 = asNumber(row.m2);
    const m3 = asNumber(row.m3);
    const m4 = asNumber(row.m4);
    // Stata population-moment definitions
    const skewness =
      m2 !== null && m3 !== null && m2 > 0 ? m3 / Math.pow(m2, 1.5) : null;
    const kurtosis =
      m2 !== null && m4 !== null && m2 > 0 ? m4 / (m2 * m2) : null;
    const smallest: number[] = [];
    for (let k = 1; k <= Math.min(4, n); k++) {
      const v = asNumber(row[`small_${k}`]);
      if (v !== null) smallest.push(v);
    }
    const largest: number[] = [];
    for (let i = Math.min(4, n); i >= 1; i--) {
      // large_i was emitted from x_(N) down to x_(N-3); display ascending
      const v = asNumber(row[`large_${i}`]);
      if (v !== null) largest.push(v);
    }
    const block: ResultBlock = {
      kind: "sumDetail",
      variable,
      n,
      sum: asNumber(row.sum),
      mean,
      sd: asNumber(row.sd),
      variance: asNumber(row.variance),
      skewness,
      kurtosis,
      percentiles: DETAIL_PERCENTILES.map((p) => ({
        p,
        value: asNumber(row[`p${p}`]),
      })),
      smallest,
      largest,
    };
    return { block, sql: detailSql };
  });

  const results = await Promise.all(detailJobs);
  return {
    blocks: results.map((r) => r.block),
    sqls: results.flatMap((r) => (r.sql === null ? [] : [r.sql])),
  };
}

async function runSumDetail(
  plan: SumDetailPlan,
  ctx: CommandExecutionContext
): Promise<{ blocks: ResultBlock[]; sql: string }> {
  const blocks: ResultBlock[] = [];
  if (plan.skipped.length > 0) {
    blocks.push({
      kind: "text",
      text: `note: omitted non-numeric variable(s): ${plan.skipped.join(", ")}`,
    });
  }
  if (plan.by === undefined) {
    const phase1 = await ctx.runReadOnlySql(plan.phase1Sql);
    const detail = await sumDetailBlocks(plan, phase1.rows[0] ?? {}, ctx);
    blocks.push(...detail.blocks);
    return {
      blocks,
      sql: [plan.phase1Sql, ...detail.sqls].join(";\n\n"),
    };
  }
  // by groups: phase 1 is one grouped scan; phase 2 depends on each
  // group's N, so it runs group by group (variables concurrently)
  const result = await runByGroups(plan.by, plan.phase1Sql, ctx);
  let firstGroupSqls: string[] = [];
  for (const key of result.groups) {
    const wide = result.rowsByGroup.get(JSON.stringify(key))?.[0] ?? {};
    const detail = await sumDetailBlocks(plan, wide, ctx, key);
    blocks.push(
      { kind: "byGroup", label: byGroupLabel(plan.by.variables, key) },
      ...detail.blocks
    );
    if (firstGroupSqls.length === 0) {
      firstGroupSqls = detail.sqls;
    }
  }
  blocks.push(...byTruncationNote(result.groups.length, result.nGroups));
  // the per-group detail queries differ only in their group condition,
  // so only the first group's are recorded
  const sqlParts = [plan.by.groupsSql, plan.phase1Sql, ...firstGroupSqls];
  if (result.groups.length > 1 && firstGroupSqls.length > 0) {
    sqlParts.push(
      `-- the detail queries above repeat for each of the ${result.groups.length} groups`
    );
  }
  return { blocks, sql: sqlParts.join(";\n\n") };
}

function tabulateBlocks(plan: TabulatePlan, resRows: Row[]): ResultBlock[] {
  // percentages always display with two decimals (like Stata), so they
  // are formatted here rather than left to generic numeric display
  const pct = (v: unknown): CellValue => {
    const n = asNumber(v);
    return n === null ? null : n.toFixed(2);
  };
  const rows = resRows.map((row: Row): CellValue[] => [
    // Stata renders missing as "."
    row.value == null
      ? "."
      : plan.numericValue
      ? asNumber(row.value)
      : asString(row.value),
    asNumber(row.freq),
    pct(row.percent),
    pct(row.cum_percent),
  ]);
  const total = rows.reduce(
    (acc, r) => acc + ((r[1] as number | null) ?? 0),
    0
  );
  const nGroups = asNumber(resRows[0]?.n_groups) ?? rows.length;
  const truncNote =
    nGroups > rows.length
      ? ` — showing first ${rows.length} of ${nGroups} distinct values`
      : "";
  const nullNote = plan.missing ? "" : " (null values excluded)";
  const blocks: ResultBlock[] = [
    {
      kind: "table",
      columns: [plan.variable, "Freq.", "Percent", "Cum."],
      align: ["left", "right", "right", "right"],
      rows,
    },
    {
      kind: "text",
      text: `Total: ${total}${nullNote}${truncNote}`,
    },
  ];
  return blocks;
}

/**
 * Correlate renders the lower triangle of the matrix as a table whose
 * first column holds the row variable. Correlations display with Stata's
 * four decimals; covariances keep generic numeric formatting.
 */
async function runCorrelate(
  plan: CorrelatePlan,
  ctx: CommandExecutionContext
): Promise<{ blocks: ResultBlock[]; sql: string }> {
  const { blocks, sql } = await runMaybeBy(plan, ctx, (rows) =>
    correlateBlocks(plan, rows[0] ?? {})
  );
  if (plan.skipped.length === 0) {
    return { blocks, sql };
  }
  // the note precedes all by groups rather than repeating in each
  const note: ResultBlock = {
    kind: "text",
    text: `note: omitted non-numeric variable(s): ${plan.skipped.join(", ")}`,
  };
  return { blocks: [note, ...blocks], sql };
}

function correlateBlocks(plan: CorrelatePlan, wide: Row): ResultBlock[] {
  const n = asNumber(wide.n) ?? 0;
  const blocks: ResultBlock[] = [{ kind: "text", text: `(obs=${n})` }];
  if (n === 0) {
    return blocks;
  }
  const cell = (i: number, j: number): CellValue => {
    if (i === j && !plan.covariance) {
      return "1.0000";
    }
    const v = asNumber(wide[`c_${i}_${j}`]);
    if (v === null) {
      return null;
    }
    return plan.covariance ? v : v.toFixed(4);
  };
  const rows = plan.variables.map((variable, i): CellValue[] => {
    const cells: CellValue[] = [variable];
    for (let j = 0; j < plan.variables.length; j++) {
      cells.push(j <= i ? cell(i, j) : null);
    }
    return cells;
  });
  blocks.push({
    kind: "table",
    columns: ["", ...plan.variables],
    align: ["left", ...plan.variables.map((): "left" | "right" => "right")],
    rows,
  });
  return blocks;
}

async function runCodebook(
  plan: CodebookPlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  // all scalar stats arrive from a single scan; top-values queries (one
  // per categorical variable) run concurrently on pooled connections
  const statsPromise = ctx.runReadOnlySql(plan.statsSql);
  const topValuePromises = plan.variables.map((varPlan) =>
    varPlan.topValuesSql === undefined
      ? Promise.resolve(null)
      : ctx.runReadOnlySql(varPlan.topValuesSql)
  );
  const statsRes = await statsPromise;
  const topResults = await Promise.all(topValuePromises);
  const wide: Row = statsRes.rows[0] ?? {};

  return plan.variables.map((varPlan, idx): ResultBlock => {
    const block: ResultBlock = {
      kind: "codebookVar",
      variable: varPlan.variable,
      sqlType: varPlan.sqlType,
      n: asNumber(wide[`n_${idx}`]) ?? 0,
      missing: asNumber(wide[`missing_${idx}`]) ?? 0,
      distinct: asNumber(wide[`distinct_${idx}`]) ?? 0,
    };
    if (varPlan.ordered) {
      block.min = asString(wide[`min_${idx}`]);
      block.max = asString(wide[`max_${idx}`]);
    } else {
      const topRes = topResults[idx];
      block.topValues =
        topRes === null
          ? []
          : topRes.rows.map((row: Row) => ({
              value: asString(row.value) ?? "",
              freq: asNumber(row.freq) ?? 0,
            }));
    }
    return block;
  });
}

/**
 * Distinct renders one row per variable (or a single row for the whole
 * varlist with `joint`), matching Stata's total / distinct panel.
 */
function distinctBlocks(plan: DistinctPlan, wide: Row): ResultBlock[] {
  const rows: CellValue[][] = plan.joint
    ? [
        [
          plan.variables.join(" "),
          asNumber(wide.total) ?? 0,
          asNumber(wide.n_distinct) ?? 0,
        ],
      ]
    : plan.variables.map((variable, idx): CellValue[] => [
        variable,
        asNumber(wide[`total_${idx}`]) ?? 0,
        asNumber(wide[`distinct_${idx}`]) ?? 0,
      ]);
  return [
    {
      kind: "table",
      columns: [plan.joint ? "Variables" : "Variable", "Total", "Distinct"],
      align: ["left", "right", "right"],
      rows,
    },
    {
      kind: "text",
      text: plan.missing
        ? "missing counted as a distinct value"
        : "missing values excluded",
    },
  ];
}

/**
 * Duplicates report renders Stata's copies / observations / surplus
 * panel, preceded by the header naming the varlist it was computed over
 * and followed by the totals (Stata prints only the panel, but the
 * surplus total is the number a `duplicates drop` would remove).
 */
async function runDuplicates(
  plan: DuplicatesPlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const res = await ctx.runReadOnlySql(plan.sql);
  const header: ResultBlock = {
    kind: "text",
    text: `Duplicates in terms of ${
      plan.allVariables ? "all variables" : plan.variables.join(" ")
    }`,
  };
  if (res.rows.length === 0) {
    return [header, { kind: "text", text: "no observations" }];
  }
  const rows = res.rows.map((row: Row): CellValue[] => [
    asNumber(row.copies),
    asNumber(row.observations),
    asNumber(row.surplus),
  ]);
  const sumColumn = (idx: number) =>
    rows.reduce((acc, r) => acc + ((r[idx] as number | null) ?? 0), 0);
  const nRows = asNumber(res.rows[0].n_rows) ?? rows.length;
  const truncNote =
    nRows > rows.length
      ? ` — showing first ${rows.length} of ${nRows} copy counts`
      : "";
  return [
    header,
    {
      kind: "table",
      columns: ["Copies", "Observations", "Surplus"],
      align: ["right", "right", "right"],
      rows,
    },
    {
      kind: "text",
      text: `Total: ${sumColumn(1)} observations, ${sumColumn(
        2
      )} surplus${truncNote}`,
    },
  ];
}

function countBlocks(rows: Row[]): ResultBlock[] {
  const n = asNumber(rows[0]?.n) ?? 0;
  return [{ kind: "text", text: String(n) }];
}

function listBlocks(plan: ListPlan, resRows: Row[]): ResultBlock[] {
  if (plan.by !== undefined && resRows.length === 0) {
    // like Stata, a by group with no matching rows lists nothing
    return [];
  }
  const total = asNumber(resRows[0]?.n_total) ?? resRows.length;
  const rows = resRows.map((row: Row, i: number): CellValue[] => [
    i + 1,
    ...plan.variables.map((v): CellValue => {
      const val = row[v];
      if (val == null) return ".";
      if (typeof val === "number") return val;
      if (typeof val === "bigint") return Number(val);
      if (typeof val === "boolean") return val;
      return String(val);
    }),
  ]);
  const blocks: ResultBlock[] = [
    {
      kind: "table",
      columns: ["#", ...plan.variables],
      align: ["right", ...plan.variables.map((v): "left" | "right" => "left")],
      rows,
    },
  ];
  if (total > rows.length) {
    blocks.push({
      kind: "text",
      text: `showing first ${rows.length} of ${total} rows`,
    });
  }
  return blocks;
}

async function runDescribe(
  plan: DescribePlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const res = await ctx.runReadOnlySql(plan.countSql);
  const n = asNumber(res.rows[0]?.n) ?? 0;
  return [
    {
      kind: "text",
      text: `Observations: ${n.toLocaleString("en-US")} — Variables: ${
        plan.variables.length
      }`,
    },
    {
      kind: "table",
      columns: ["Variable", "Type"],
      align: ["left", "left"],
      rows: plan.variables.map((v): CellValue[] => [v.name, v.sqlType]),
    },
  ];
}

async function runHistogram(
  plan: HistogramPlan,
  ctx: CommandExecutionContext
): Promise<{ blocks: ResultBlock[]; sql: string }> {
  const statsRes = await ctx.runReadOnlySql(plan.statsSql);
  const statsRow: Row = statsRes.rows[0] ?? {};
  const n = asNumber(statsRow.n) ?? 0;
  const minVal = asNumber(statsRow.min);
  const maxVal = asNumber(statsRow.max);
  if (n === 0 || minVal === null || maxVal === null) {
    return {
      blocks: [{ kind: "text", text: "no observations" }],
      sql: plan.statsSql,
    };
  }
  const binCount =
    plan.requestedBins !== undefined
      ? plan.requestedBins
      : defaultHistogramBins(n);
  const binWidth = binCount > 0 ? (maxVal - minVal) / binCount : 0;
  const binsSql = plan.mkBinsSql(minVal, binWidth, binCount);
  const binsRes = await ctx.runReadOnlySql(binsSql);
  const freqs = new Array<number>(Math.max(1, binCount)).fill(0);
  for (const row of binsRes.rows) {
    const bin = asNumber(row.bin);
    const freq = asNumber(row.freq);
    if (bin !== null && freq !== null && bin >= 0 && bin < freqs.length) {
      freqs[bin] = freq;
    }
  }
  const block: ResultBlock = {
    kind: "histogram",
    variable: plan.variable,
    n,
    binStart: minVal,
    binWidth: binWidth > 0 ? binWidth : 1,
    freqs,
  };
  return { blocks: [block], sql: [plan.statsSql, binsSql].join(";\n\n") };
}

async function runGrid(
  plan: GridPlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const update: GridUpdate = {
    displayColumns: plan.displayColumns,
    sortKey: plan.sortKey,
  };
  if (plan.sessionChanged) {
    update.sessionFilter = plan.sessionFilter;
    update.gridFilterExp = plan.gridFilterExp;
  }
  if (plan.op === "keep" || plan.op === "drop" || plan.op === "order") {
    update.sessionColumns = plan.displayColumns;
  }
  await ctx.applyGrid(update);
  return [{ kind: "text", text: plan.note }];
}

/**
 * Execute a command line against the given context. Never throws:
 * failures (lex/parse/resolve/plan/execution) are reported as a
 * CommandFailure with a human-readable message.
 */
export async function executeCommand(
  input: string,
  ctx: CommandExecutionContext
): Promise<CommandOutcome> {
  try {
    const parsed = parseCommand(input);
    const resolved = resolveCommand(parsed, ctx.schema.columns);
    const plan = planCommand(resolved, {
      schema: ctx.schema,
      dialect: ctx.dialect,
      baseQuery: ctx.baseQuery,
      sessionFilter: ctx.sessionFilter,
      sortKey: ctx.sortKey,
    });
    switch (plan.kind) {
      case "browse": {
        await ctx.applyGrid({
          displayColumns: plan.columns,
          gridFilterExp: plan.filterExp,
        });
        const filterNote = plan.filterExp === null ? "" : " (filtered)";
        const blocks: ResultBlock[] = [
          {
            kind: "text",
            text: `browse: showing ${plan.columns.length} column${
              plan.columns.length === 1 ? "" : "s"
            }${filterNote}`,
          },
        ];
        return ok("browse", input, plan.sql, blocks);
      }
      case "summarize": {
        const { blocks, sql } = await runMaybeBy(plan, ctx, (rows) =>
          summarizeBlocks(plan, rows)
        );
        return ok("summarize", input, sql, blocks);
      }
      case "sumDetail": {
        const { blocks, sql } = await runSumDetail(plan, ctx);
        return ok("summarize", input, sql, blocks);
      }
      case "tabulate": {
        const { blocks, sql } = await runMaybeBy(plan, ctx, (rows) =>
          tabulateBlocks(plan, rows)
        );
        return ok("tabulate", input, sql, blocks);
      }
      case "correlate": {
        const { blocks, sql } = await runCorrelate(plan, ctx);
        return ok("correlate", input, sql, blocks);
      }
      case "codebook": {
        const blocks = await runCodebook(plan, ctx);
        const sql = [
          plan.statsSql,
          ...plan.variables
            .filter((v) => v.topValuesSql !== undefined)
            .map((v) => v.topValuesSql!),
        ].join(";\n\n");
        return ok("codebook", input, sql, blocks);
      }
      case "distinct": {
        const { blocks, sql } = await runMaybeBy(plan, ctx, (rows) =>
          distinctBlocks(plan, rows[0] ?? {})
        );
        return ok("distinct", input, sql, blocks);
      }
      case "duplicates":
        return ok(
          "duplicates",
          input,
          plan.sql,
          await runDuplicates(plan, ctx)
        );
      case "count": {
        const { blocks, sql } = await runMaybeBy(plan, ctx, countBlocks);
        return ok("count", input, sql, blocks);
      }
      case "list": {
        const { blocks, sql } = await runMaybeBy(plan, ctx, (rows) =>
          listBlocks(plan, rows)
        );
        return ok("list", input, sql, blocks);
      }
      case "describe":
        return ok(
          "describe",
          input,
          plan.countSql,
          await runDescribe(plan, ctx)
        );
      case "ds":
        return ok("ds", input, "", [
          { kind: "text", text: plan.variables.join("  ") },
        ]);
      case "grid":
        return ok(plan.op, input, plan.sql, await runGrid(plan, ctx));
      case "histogram": {
        const { blocks, sql } = await runHistogram(plan, ctx);
        return ok("histogram", input, sql, blocks);
      }
    }
  } catch (e) {
    if (e instanceof StataCommandError) {
      return {
        status: "error",
        command: input,
        error: formatCommandError(input, e),
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "error", command: input, error: msg };
  }
}
