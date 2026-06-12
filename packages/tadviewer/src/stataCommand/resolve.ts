/**
 * Schema resolution for parsed Stata commands: replaces every variable
 * reference with the exact column id of the active schema.
 *
 * Matching rules (deterministic, case-sensitive like Stata):
 * - An exact match always wins.
 * - An unquoted reference may abbreviate a column name by any prefix,
 *   but only if exactly one column starts with that prefix; otherwise an
 *   ambiguity error lists the candidates.
 * - A backtick-quoted reference must match exactly (no abbreviation).
 * - An empty varlist for browse / summarize / codebook expands to all
 *   columns in schema order.
 */

import {
  Expr,
  Operand,
  ParsedCommand,
  ParsedExpr,
  ParsedOperand,
  StataCommand,
  VarRef,
} from "./ast";
import { StataCommandError } from "./errors";

const MAX_CANDIDATES_LISTED = 8;

export function resolveVar(ref: VarRef, columns: string[]): string {
  // exact match always wins, quoted or not
  if (columns.indexOf(ref.name) >= 0) {
    return ref.name;
  }
  if (ref.quoted) {
    throw new StataCommandError(
      "resolve",
      `unknown variable '${ref.name}'`,
      ref.pos
    );
  }
  const candidates = columns.filter((c) => c.startsWith(ref.name));
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    throw new StataCommandError(
      "resolve",
      `unknown variable '${ref.name}'`,
      ref.pos
    );
  }
  const listed = candidates.slice(0, MAX_CANDIDATES_LISTED);
  const more =
    candidates.length > listed.length
      ? ` (and ${candidates.length - listed.length} more)`
      : "";
  throw new StataCommandError(
    "resolve",
    `ambiguous variable '${ref.name}': matches ${listed.join(", ")}${more}`,
    ref.pos
  );
}

function resolveVarlist(
  refs: VarRef[],
  columns: string[],
  emptyMeansAll: boolean
): string[] {
  if (refs.length === 0) {
    return emptyMeansAll ? columns.slice() : [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    const colId = resolveVar(ref, columns);
    if (seen.has(colId)) {
      throw new StataCommandError(
        "resolve",
        `variable '${colId}' appears more than once`,
        ref.pos
      );
    }
    seen.add(colId);
    out.push(colId);
  }
  return out;
}

function resolveOperand(op: ParsedOperand, columns: string[]): Operand {
  if (op.kind === "var") {
    return { kind: "var", name: resolveVar(op.ref, columns) };
  }
  return op;
}

export function resolveExpr(expr: ParsedExpr, columns: string[]): Expr {
  switch (expr.kind) {
    case "cmp":
      return {
        kind: "cmp",
        op: expr.op,
        lhs: resolveOperand(expr.lhs, columns),
        rhs: resolveOperand(expr.rhs, columns),
      };
    case "and":
      return {
        kind: "and",
        args: expr.args.map((e) => resolveExpr(e, columns)),
      };
    case "or":
      return {
        kind: "or",
        args: expr.args.map((e) => resolveExpr(e, columns)),
      };
  }
}

/**
 * Resolve a parsed command against the list of column ids of the active
 * schema. Throws StataCommandError for unknown or ambiguous variables.
 */
export function resolveCommand(
  cmd: ParsedCommand,
  columns: string[]
): StataCommand {
  switch (cmd.kind) {
    case "browse":
    case "summarize": {
      const variables = resolveVarlist(cmd.variables, columns, true);
      const filter =
        cmd.filter === undefined
          ? undefined
          : resolveExpr(cmd.filter, columns);
      return filter === undefined
        ? { kind: cmd.kind, variables }
        : { kind: cmd.kind, variables, filter };
    }
    case "tabulate": {
      const variable = resolveVar(cmd.variable, columns);
      const filter =
        cmd.filter === undefined
          ? undefined
          : resolveExpr(cmd.filter, columns);
      return filter === undefined
        ? { kind: "tabulate", variable }
        : { kind: "tabulate", variable, filter };
    }
    case "codebook": {
      const variables = resolveVarlist(cmd.variables, columns, true);
      return { kind: "codebook", variables };
    }
  }
}
