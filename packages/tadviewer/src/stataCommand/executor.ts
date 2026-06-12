/**
 * Command execution: parse -> resolve -> plan -> execute.
 *
 * The executor is decoupled from the UI through CommandExecutionContext:
 * browse hands its compiled filter/projection to applyBrowse (the grid),
 * while summarize / tabulate / codebook run their generated SQL through
 * the read-only SQL API and convert rows into renderable ResultBlocks.
 */

import {
  FilterExp,
  QueryExp,
  ReadOnlySqlResult,
  Row,
  Schema,
  SQLDialect,
} from "reltab";
import { CommandKind } from "./ast";
import { formatCommandError, StataCommandError } from "./errors";
import { parseCommand } from "./parser";
import { resolveCommand } from "./resolve";
import {
  CodebookPlan,
  planCommand,
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
    };

export interface CommandExecutionContext {
  /** schema of the data columns of the current view */
  schema: Schema;
  dialect: SQLDialect;
  baseQuery: QueryExp;
  runReadOnlySql(sql: string): Promise<ReadOnlySqlResult>;
  /** apply a browse command to the main grid */
  applyBrowse(
    columns: string[],
    filterExp: FilterExp | null
  ): void | Promise<void>;
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

async function runTabulate(
  plan: TabulatePlan,
  ctx: CommandExecutionContext
): Promise<ResultBlock[]> {
  const res = await ctx.runReadOnlySql(plan.sql);
  const rows = res.rows.map((row: Row): CellValue[] => [
    asString(row.value),
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
  const blocks: ResultBlock[] = [
    {
      kind: "table",
      columns: [plan.variable, "Freq.", "Percent", "Cum."],
      align: ["left", "right", "right", "right"],
      rows,
    },
    {
      kind: "text",
      text: `Total: ${total} (null values excluded)${truncNote}`,
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

/**
 * Execute a command line against the given context. Never throws:
 * failures (lex/parse/resolve/execution) are reported as a
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
    });
    switch (plan.kind) {
      case "browse": {
        await ctx.applyBrowse(plan.columns, plan.filterExp);
        const filterNote = plan.filterExp === null ? "" : " (filtered)";
        const blocks: ResultBlock[] = [
          {
            kind: "text",
            text: `browse: showing ${plan.columns.length} column${
              plan.columns.length === 1 ? "" : "s"
            }${filterNote}`,
          },
        ];
        return {
          status: "ok",
          kind: "browse",
          command: input,
          sql: plan.sql,
          blocks,
        };
      }
      case "summarize": {
        const blocks = await runSummarize(plan, ctx);
        return {
          status: "ok",
          kind: "summarize",
          command: input,
          sql: plan.sql,
          blocks,
        };
      }
      case "tabulate": {
        const blocks = await runTabulate(plan, ctx);
        return {
          status: "ok",
          kind: "tabulate",
          command: input,
          sql: plan.sql,
          blocks,
        };
      }
      case "codebook": {
        const blocks = await runCodebook(plan, ctx);
        const sql = [
          plan.statsSql,
          ...plan.variables
            .filter((v) => v.topValuesSql !== undefined)
            .map((v) => v.topValuesSql!),
        ].join(";\n\n");
        return {
          status: "ok",
          kind: "codebook",
          command: input,
          sql,
          blocks,
        };
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
