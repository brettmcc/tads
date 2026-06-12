/**
 * Recursive-descent parser for the Stata-like command language.
 *
 * Grammar (deterministic, no backtracking):
 *
 *   command   := browseCmd | summarizeCmd | tabulateCmd | codebookCmd
 *   browseCmd    := BROWSE varlist? ifClause?
 *   summarizeCmd := SUM varlist? ifClause?
 *   tabulateCmd  := TAB varname ifClause?
 *   codebookCmd  := CODEBOOK varlist?
 *   ifClause  := 'if' expr
 *   varlist   := varname+
 *   varname   := WORD | QUOTED
 *
 *   expr      := orExpr
 *   orExpr    := andExpr ( '|' andExpr )*
 *   andExpr   := boolPrim ( '&' boolPrim )*
 *   boolPrim  := '(' orExpr ')' | comparison
 *   comparison := operand relop operand
 *   relop     := '==' | '=' | '!=' | '~=' | '<' | '<=' | '>' | '>='
 *   operand   := NUMBER | '-' NUMBER | STRING | 'null'
 *              | 'date' '(' STRING ')' | varname
 *
 * Precedence (tightest to loosest): parentheses, comparison, '&', '|'.
 *
 * Command names accepted (lowercase only, like Stata):
 *   browse:    bro | brow | brows | browse
 *   summarize: sum | summ | summa | summar | summari | summariz | summarize
 *   tabulate:  tab | tabu | tabul | tabula | tabulat | tabulate
 *   codebook:  codebook
 *
 * Notes:
 * - `=` is accepted as a synonym for `==`, and `~=` for `!=`.
 * - `null` may only appear with `==`/`!=`.
 * - The keywords `if`, `null`, and `date` are contextual: a column whose
 *   name collides with one of them can always be referenced by backtick
 *   quoting (`if`, `null`, `date`).
 * - Date literals use the explicit deterministic form date("YYYY-MM-DD")
 *   or date("YYYY-MM-DD HH:MM[:SS]") (a 'T' separator is also accepted).
 */

import {
  CmpOp,
  ParsedCommand,
  ParsedExpr,
  ParsedOperand,
  VarRef,
} from "./ast";
import { StataCommandError } from "./errors";
import { lex, Token } from "./lexer";

const COMMAND_FORMS: Array<{
  kind: "browse" | "summarize" | "tabulate" | "codebook";
  full: string;
  minPrefix: number;
}> = [
  { kind: "browse", full: "browse", minPrefix: 3 },
  { kind: "summarize", full: "summarize", minPrefix: 3 },
  { kind: "tabulate", full: "tabulate", minPrefix: 3 },
  { kind: "codebook", full: "codebook", minPrefix: 8 },
];

function matchCommandName(
  name: string
): "browse" | "summarize" | "tabulate" | "codebook" | null {
  for (const form of COMMAND_FORMS) {
    if (
      name.length >= form.minPrefix &&
      name.length <= form.full.length &&
      form.full.startsWith(name)
    ) {
      return form.kind;
    }
  }
  return null;
}

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** validate a date literal's contents; returns hasTime */
function checkDateLiteral(text: string, pos: number): boolean {
  const m = DATE_RE.exec(text);
  if (!m) {
    throw new StataCommandError(
      "parse",
      `invalid date literal '${text}': expected date("YYYY-MM-DD") or date("YYYY-MM-DD HH:MM[:SS]")`,
      pos
    );
  }
  const [, ys, mos, ds, hs, mins, ss] = m;
  const y = Number(ys),
    mo = Number(mos),
    d = Number(ds);
  const h = hs === undefined ? 0 : Number(hs);
  const mi = mins === undefined ? 0 : Number(mins);
  const s = ss === undefined ? 0 : Number(ss);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const valid =
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d &&
    dt.getUTCHours() === h &&
    dt.getUTCMinutes() === mi &&
    dt.getUTCSeconds() === s;
  if (!valid) {
    throw new StataCommandError(
      "parse",
      `invalid date literal '${text}': no such date/time`,
      pos
    );
  }
  return hs !== undefined;
}

class Parser {
  private readonly tokens: Token[];
  private idx: number;

  constructor(private readonly input: string) {
    this.tokens = lex(input);
    this.idx = 0;
  }

  private peek(): Token {
    return this.tokens[this.idx];
  }

  private next(): Token {
    return this.tokens[this.idx++];
  }

  private error(message: string, pos?: number): never {
    throw new StataCommandError("parse", message, pos ?? this.peek().pos);
  }

  parseCommand(): ParsedCommand {
    const first = this.peek();
    if (first.type === "eof") {
      this.error("empty command");
    }
    if (first.type !== "word") {
      this.error(
        "expected a command name (browse, sum, tab, or codebook)",
        first.pos
      );
    }
    const kind = matchCommandName(first.text);
    if (kind === null) {
      this.error(
        `unknown command '${first.text}': expected bro[wse], sum[marize], tab[ulate], or codebook`,
        first.pos
      );
    }
    this.next();

    switch (kind) {
      case "browse": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        this.expectEof();
        return filter === undefined
          ? { kind, variables }
          : { kind, variables, filter };
      }
      case "summarize": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        this.expectEof();
        return filter === undefined
          ? { kind, variables }
          : { kind, variables, filter };
      }
      case "tabulate": {
        const variables = this.parseVarlist();
        if (variables.length === 0) {
          this.error("tab requires a variable name");
        }
        if (variables.length > 1) {
          this.error(
            "tab accepts exactly one variable",
            variables[1].pos
          );
        }
        const filter = this.parseOptionalIf();
        this.expectEof();
        return filter === undefined
          ? { kind, variable: variables[0] }
          : { kind, variable: variables[0], filter };
      }
      case "codebook": {
        const variables = this.parseVarlist();
        const tok = this.peek();
        if (tok.type === "word" && tok.text === "if") {
          this.error("codebook does not support an if clause", tok.pos);
        }
        this.expectEof();
        return { kind, variables };
      }
    }
  }

  private expectEof(): void {
    const tok = this.peek();
    if (tok.type !== "eof") {
      this.error(
        `unexpected input after end of command: '${tok.text}'`,
        tok.pos
      );
    }
  }

  /** parse zero or more variable names, stopping at `if` or end of input */
  private parseVarlist(): VarRef[] {
    const vars: VarRef[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.type === "word") {
        if (tok.text === "if") {
          break;
        }
        this.next();
        vars.push({ name: tok.text, quoted: false, pos: tok.pos });
      } else if (tok.type === "quotedIdent") {
        this.next();
        vars.push({ name: tok.text, quoted: true, pos: tok.pos });
      } else if (tok.type === "eof") {
        break;
      } else {
        this.error(
          `expected a variable name but found '${tok.text}'`,
          tok.pos
        );
      }
    }
    return vars;
  }

  private parseOptionalIf(): ParsedExpr | undefined {
    const tok = this.peek();
    if (tok.type === "word" && tok.text === "if") {
      this.next();
      if (this.peek().type === "eof") {
        this.error("expected an expression after 'if'");
      }
      return this.parseOr();
    }
    return undefined;
  }

  private parseOr(): ParsedExpr {
    const args: ParsedExpr[] = [this.parseAnd()];
    while (this.peek().type === "op" && this.peek().text === "|") {
      this.next();
      args.push(this.parseAnd());
    }
    return args.length === 1 ? args[0] : { kind: "or", args };
  }

  private parseAnd(): ParsedExpr {
    const args: ParsedExpr[] = [this.parseBoolPrim()];
    while (this.peek().type === "op" && this.peek().text === "&") {
      this.next();
      args.push(this.parseBoolPrim());
    }
    return args.length === 1 ? args[0] : { kind: "and", args };
  }

  private parseBoolPrim(): ParsedExpr {
    const tok = this.peek();
    if (tok.type === "op" && tok.text === "(") {
      this.next();
      const inner = this.parseOr();
      const close = this.peek();
      if (!(close.type === "op" && close.text === ")")) {
        this.error("expected ')'", close.pos);
      }
      this.next();
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): ParsedExpr {
    const lhs = this.parseOperand();
    const opTok = this.peek();
    if (opTok.type !== "op" || !isRelOpText(opTok.text)) {
      this.error(
        `expected a comparison operator (==, !=, <, <=, >, >=) but found '${
          opTok.type === "eof" ? "end of input" : opTok.text
        }'`,
        opTok.pos
      );
    }
    this.next();
    const op = normalizeRelOp(opTok.text);
    const rhs = this.parseOperand();
    if (lhs.kind === "null" || rhs.kind === "null") {
      if (op !== "==" && op !== "!=") {
        this.error(
          `null can only be compared with == or !=, not '${opTok.text}'`,
          opTok.pos
        );
      }
    }
    return { kind: "cmp", op, lhs, rhs };
  }

  private parseOperand(): ParsedOperand {
    const tok = this.peek();
    switch (tok.type) {
      case "number": {
        this.next();
        return { kind: "number", value: parseNumber(tok) };
      }
      case "string": {
        this.next();
        return { kind: "string", value: tok.text };
      }
      case "quotedIdent": {
        this.next();
        return {
          kind: "var",
          ref: { name: tok.text, quoted: true, pos: tok.pos },
        };
      }
      case "word": {
        if (tok.text === "null") {
          this.next();
          return { kind: "null" };
        }
        if (tok.text === "date") {
          // date("...") literal; a column actually named `date` must be
          // backtick-quoted in expressions
          const after = this.tokens[this.idx + 1];
          if (after && after.type === "op" && after.text === "(") {
            this.next(); // date
            this.next(); // (
            const strTok = this.peek();
            if (strTok.type !== "string") {
              this.error(
                'date(...) requires a quoted literal, e.g. date("2026-06-12")',
                strTok.pos
              );
            }
            this.next();
            const close = this.peek();
            if (!(close.type === "op" && close.text === ")")) {
              this.error("expected ')' after date literal", close.pos);
            }
            this.next();
            const hasTime = checkDateLiteral(strTok.text, strTok.pos);
            return { kind: "date", value: strTok.text, hasTime };
          }
        }
        this.next();
        return {
          kind: "var",
          ref: { name: tok.text, quoted: false, pos: tok.pos },
        };
      }
      case "op": {
        if (tok.text === "-") {
          const numTok = this.tokens[this.idx + 1];
          if (numTok && numTok.type === "number") {
            this.next();
            this.next();
            return { kind: "number", value: -parseNumber(numTok) };
          }
          this.error("expected a number after unary '-'", tok.pos);
        }
        this.error(
          `expected a value or variable but found '${tok.text}'`,
          tok.pos
        );
      }
      case "eof": {
        this.error("unexpected end of input in expression", tok.pos);
      }
    }
  }
}

function parseNumber(tok: Token): number {
  const v = Number(tok.text);
  if (!Number.isFinite(v)) {
    throw new StataCommandError(
      "parse",
      `invalid numeric literal '${tok.text}'`,
      tok.pos
    );
  }
  return v;
}

function isRelOpText(text: string): boolean {
  switch (text) {
    case "==":
    case "=":
    case "!=":
    case "~=":
    case "<":
    case "<=":
    case ">":
    case ">=":
      return true;
    default:
      return false;
  }
}

function normalizeRelOp(text: string): CmpOp {
  switch (text) {
    case "=":
    case "==":
      return "==";
    case "~=":
    case "!=":
      return "!=";
    default:
      return text as CmpOp;
  }
}

/**
 * Parse a command line into the schema-independent AST.
 * Throws StataCommandError on any lexical or syntactic problem.
 */
export function parseCommand(input: string): ParsedCommand {
  return new Parser(input).parseCommand();
}
