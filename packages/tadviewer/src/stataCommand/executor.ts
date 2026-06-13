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
  CodebookPlan,
  CountPlan,
  defaultHistogramBins,
  DescribePlan,
  DETAIL_PERCENTILES,
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

async function runSummarize(
  plan: SummarizePlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const res = await ctx.runReadOnlySql(plan.sql);
  // one wide row of per-variable aggregates; reshape to a row per variable
  const wide: Row = res.rows[0] ?? {};
  const rows = plan.variables.map((variable, idx): CellValue[] => [
    variable,
    asNumber(wide[`n_${idx}`]),
    asNumber(wide[`mean_${idx}`]),
    asNumber(wide[`sd_${idx}`]),
    asNumber(wide[`min_${idx}`]),
    asNumber(wide[`max_${idx}`]),
  ]);
  return [
    {
      kind: "table",
      columns: ["Variable", "N", "Mean", "Std. dev.", "Min", "Max"],
      align: ["left", "right", "right", "right", "right", "right"],
      rows,
    },
  ];
}

async function runSumDetail(
  plan: SumDetailPlan,
  ctx: CommandExecutionContext
): Promise<{ blocks: ResultBlock[]; sql: string }> {
  const phase1 = await ctx.runReadOnlySql(plan.phase1Sql);
  const wide: Row = phase1.rows[0] ?? {};
  const sqlParts: string[] = [plan.phase1Sql];

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
    const detailSql = plan.mkDetailSql(variable, n, mean);
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
  for (const r of results) {
    if (r.sql !== null) {
      sqlParts.push(r.sql);
    }
  }
  return {
    blocks: results.map((r) => r.block),
    sql: sqlParts.join(";\n\n"),
  };
}

async function runTabulate(
  plan: TabulatePlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const res = await ctx.runReadOnlySql(plan.sql);
  const rows = res.rows.map((row: Row): CellValue[] => [
    // Stata renders missing as "."
    row.value == null ? "." : asString(row.value),
    asNumber(row.freq),
    asNumber(row.percent),
    asNumber(row.cum_percent),
  ]);
  const total = rows.reduce(
    (acc, r) => acc + ((r[1] as number | null) ?? 0),
    0
  );
  const nGroups = asNumber(res.rows[0]?.n_groups) ?? rows.length;
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

async function runCount(
  plan: CountPlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const res = await ctx.runReadOnlySql(plan.sql);
  const n = asNumber(res.rows[0]?.n) ?? 0;
  return [{ kind: "text", text: String(n) }];
}

async function runList(
  plan: ListPlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const res = await ctx.runReadOnlySql(plan.sql);
  const total = asNumber(res.rows[0]?.n_total) ?? res.rows.length;
  const rows = res.rows.map((row: Row, i: number): CellValue[] => [
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
      case "summarize":
        return ok(
          "summarize",
          input,
          plan.sql,
          await runSummarize(plan, ctx)
        );
      case "sumDetail": {
        const { blocks, sql } = await runSumDetail(plan, ctx);
        return ok("summarize", input, sql, blocks);
      }
      case "tabulate":
        return ok("tabulate", input, plan.sql, await runTabulate(plan, ctx));
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
      case "count":
        return ok("count", input, plan.sql, await runCount(plan, ctx));
      case "list":
        return ok("list", input, plan.sql, await runList(plan, ctx));
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
