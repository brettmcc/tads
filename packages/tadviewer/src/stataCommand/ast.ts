/**
 * AST for the small, deterministic Stata-like command language.
 *
 * Two flavors of the AST exist:
 *
 * - The *parsed* form (`ParsedCommand`), produced by the parser with no
 *   knowledge of the data schema. Variable references carry their source
 *   position and whether they were backtick-quoted (quoted references are
 *   resolved by exact match only; unquoted ones may use unique-prefix
 *   abbreviation).
 *
 * - The *resolved* form (`StataCommand`), produced by schema resolution,
 *   in which every variable reference has been replaced by the exact
 *   column id of the active schema.
 */

/** A variable reference as written in the command text. */
export interface VarRef {
  name: string;
  /** true iff written with backtick quoting; disables prefix matching */
  quoted: boolean;
  /** 0-based character offset of the reference in the command text */
  pos: number;
}

export type ParsedLiteral =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "date"; value: string; hasTime: boolean }
  | { kind: "null" };

export type ParsedOperand = ParsedLiteral | { kind: "var"; ref: VarRef };

/** Comparison operators, normalized: `=` -> `==`, `~=` -> `!=`. */
export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type ParsedExpr =
  | { kind: "cmp"; op: CmpOp; lhs: ParsedOperand; rhs: ParsedOperand }
  | { kind: "and"; args: ParsedExpr[] }
  | { kind: "or"; args: ParsedExpr[] };

export type ParsedCommand =
  | { kind: "browse"; variables: VarRef[]; filter?: ParsedExpr }
  | { kind: "summarize"; variables: VarRef[]; filter?: ParsedExpr }
  | { kind: "tabulate"; variable: VarRef; filter?: ParsedExpr }
  | { kind: "codebook"; variables: VarRef[] };

/* ----- resolved form ----- */

export type Literal = ParsedLiteral;

export type Operand = Literal | { kind: "var"; name: string };

export type Expr =
  | { kind: "cmp"; op: CmpOp; lhs: Operand; rhs: Operand }
  | { kind: "and"; args: Expr[] }
  | { kind: "or"; args: Expr[] };

/**
 * A fully resolved command. `variables` always holds exact column ids of
 * the active schema; for browse/summarize/codebook an omitted varlist has
 * been expanded to all columns.
 */
export type StataCommand =
  | { kind: "browse"; variables: string[]; filter?: Expr }
  | { kind: "summarize"; variables: string[]; filter?: Expr }
  | { kind: "tabulate"; variable: string; filter?: Expr }
  | { kind: "codebook"; variables: string[] };

export type CommandKind = StataCommand["kind"];
