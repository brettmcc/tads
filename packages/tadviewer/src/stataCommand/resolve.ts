/**
 * Schema resolution for parsed Stata commands: replaces every variable
 * reference with the exact column id of the active schema.
 *
 * Matching rules (deterministic, case-sensitive like Stata):
 * - An exact match always wins.
 * - A name containing `*` or `?` is a Stata-style wildcard pattern
 *   (`*` = any run of characters, `?` = exactly one character); it
 *   expands to every matching column in schema order. A bare `*` means
 *   all variables. Patterns matching nothing are an error.
 * - Otherwise an unquoted reference may abbreviate a column name by any
 *   prefix, but only if exactly one column starts with that prefix; an
 *   ambiguity error lists the candidates.
 * - A backtick-quoted reference must match exactly (no abbreviation, no
 *   wildcards).
 * - An empty varlist expands to all columns in schema order where the
 *   command permits it.
 * - Wildcards are not allowed in expressions, tab/histogram variables,
 *   or gsort keys (each names a single column).
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

function isPattern(ref: VarRef): boolean {
  return !ref.quoted && /[*?]/.test(ref.name);
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
}

/** resolve a single non-pattern reference to exactly one column id */
export function resolveVar(ref: VarRef, columns: string[]): string {
  if (isPattern(ref)) {
    throw new StataCommandError(
      "resolve",
      `wildcards are not allowed here ('${ref.name}' names a single variable)`,
      ref.pos
    );
  }
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

/**
 * Resolve a varlist, expanding wildcard patterns in schema order.
 * Duplicates arising from overlapping patterns are dropped silently;
 * explicitly repeating the same non-pattern name is an error.
 */
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
    if (isPattern(ref)) {
      const re = patternToRegex(ref.name);
      const matches = columns.filter((c) => re.test(c));
      if (matches.length === 0) {
        throw new StataCommandError(
          "resolve",
          `no variables match pattern '${ref.name}'`,
          ref.pos
        );
      }
      for (const colId of matches) {
        if (!seen.has(colId)) {
          seen.add(colId);
          out.push(colId);
        }
      }
    } else {
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

const maybeFilter = (
  filter: ParsedExpr | undefined,
  columns: string[]
): Expr | undefined =>
  filter === undefined ? undefined : resolveExpr(filter, columns);

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
    case "list": {
      const variables = resolveVarlist(cmd.variables, columns, true);
      const filter = maybeFilter(cmd.filter, columns);
      return filter === undefined
        ? { kind: cmd.kind, variables }
        : { kind: cmd.kind, variables, filter };
    }
    case "summarize": {
      const variables = resolveVarlist(cmd.variables, columns, true);
      const filter = maybeFilter(cmd.filter, columns);
      const base = { kind: cmd.kind, variables, detail: cmd.detail } as const;
      return filter === undefined ? { ...base } : { ...base, filter };
    }
    case "tabulate": {
      const variable = resolveVar(cmd.variable, columns);
      const filter = maybeFilter(cmd.filter, columns);
      const base = {
        kind: "tabulate",
        variable,
        missing: cmd.missing,
      } as const;
      return filter === undefined ? { ...base } : { ...base, filter };
    }
    case "codebook":
    case "describe":
    case "ds": {
      const variables = resolveVarlist(cmd.variables, columns, true);
      return { kind: cmd.kind, variables };
    }
    case "count": {
      const filter = maybeFilter(cmd.filter, columns);
      return filter === undefined
        ? { kind: "count" }
        : { kind: "count", filter };
    }
    case "order": {
      const variables = resolveVarlist(cmd.variables, columns, false);
      return { kind: "order", variables, last: cmd.last };
    }
    case "sort": {
      const variables = resolveVarlist(cmd.variables, columns, false);
      return { kind: "sort", variables };
    }
    case "gsort": {
      const seen = new Set<string>();
      const keys = cmd.keys.map((k) => {
        const name = resolveVar(k.ref, columns);
        if (seen.has(name)) {
          throw new StataCommandError(
            "resolve",
            `variable '${name}' appears more than once`,
            k.ref.pos
          );
        }
        seen.add(name);
        return { name, descending: k.descending };
      });
      return { kind: "gsort", keys };
    }
    case "keep":
    case "drop": {
      if (cmd.filter !== undefined) {
        return {
          kind: cmd.kind,
          variables: [],
          filter: resolveExpr(cmd.filter, columns),
        };
      }
      const variables = resolveVarlist(cmd.variables, columns, false);
      return { kind: cmd.kind, variables };
    }
    case "histogram": {
      const variable = resolveVar(cmd.variable, columns);
      const filter = maybeFilter(cmd.filter, columns);
      const bins = cmd.bins;
      if (filter === undefined && bins === undefined) {
        return { kind: "histogram", variable };
      }
      if (filter === undefined) {
        return { kind: "histogram", variable, bins };
      }
      if (bins === undefined) {
        return { kind: "histogram", variable, filter };
      }
      return { kind: "histogram", variable, filter, bins };
    }
  }
}
