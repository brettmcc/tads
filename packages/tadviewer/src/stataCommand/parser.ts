/**
 * Recursive-descent parser for the Stata-like command language.
 *
 * Grammar (deterministic, no backtracking):
 *
 *   line    := byPrefix? command
 *   byPrefix := BY varlist ( '(' varlist ')' )? ( ',' 'sort' )? ':'
 *                                    -- only before byable commands
 *   command := browseCmd | summarizeCmd | tabulateCmd | correlateCmd
 *            | codebookCmd | distinctCmd | duplicatesCmd | describeCmd
 *            | dsCmd | listCmd | countCmd | orderCmd | sortCmd | gsortCmd
 *            | keepCmd | dropCmd | histogramCmd
 *
 *   browseCmd    := BROWSE varlist? ifClause?
 *   summarizeCmd := SUM varlist? ifClause? options?      -- option: d[etail]
 *   tabulateCmd  := TAB varname ifClause? options?       -- option: m[issing]
 *   correlateCmd := CORR varlist? ifClause? options?     -- option: cov[ariance]
 *   codebookCmd  := CODEBOOK varlist? ifClause?
 *   distinctCmd  := DISTINCT varlist? ifClause? options?
 *                                                        -- options:
 *                                                        m[issing], j[oint]
 *   duplicatesCmd := DUPLICATES r[eport] varlist? ifClause?
 *   describeCmd  := DESCRIBE varlist?
 *   dsCmd        := DS varlist?
 *   listCmd      := LIST varlist? ifClause?
 *   countCmd     := COUNT ifClause?
 *   orderCmd     := ORDER varlist options?               -- option: last
 *   sortCmd      := SORT varlist
 *   gsortCmd     := GSORT ( ('+'|'-')? varname )+
 *   keepCmd      := KEEP ( varlist | ifClause )
 *   dropCmd      := DROP ( varlist | ifClause )
 *   histogramCmd := HISTOGRAM varname ifClause? options? -- option: bin(#)
 *
 *   ifClause  := 'if' expr
 *   options   := ',' option+
 *   option    := WORD | WORD '(' NUMBER ')'
 *   varlist   := varname+
 *   varname   := WORD | QUOTED      -- WORD may contain * and ? wildcards
 *
 *   expr      := orExpr
 *   orExpr    := andExpr ( '|' andExpr )*
 *   andExpr   := boolPrim ( '&' boolPrim )*
 *   boolPrim  := '(' orExpr ')' | comparison
 *   comparison := operand relop operand
 *   relop     := '==' | '=' | '!=' | '~=' | '<' | '<=' | '>' | '>='
 *   operand   := NUMBER | '-' NUMBER | STRING | 'null' | '.'
 *             | 'date' '(' STRING ')' | varname
 *
 * Precedence (tightest to loosest): parentheses, comparison, '&', '|'.
 *
 * Command names accepted (lowercase only, like Stata):
 *   by prefix: by | bys | byso | bysor | bysort
 *   browse:    bro | brow | brows | browse
 *   summarize: sum | summ | ... | summarize
 *   tabulate:  tab | tabu | ... | tabulate
 *   correlate: cor | corr | ... | correlate
 *   codebook:  codebook
 *   distinct:  distinct
 *   duplicates: duplicates (subcommand: r | re | ... | report)
 *   describe:  des | desc | ... | describe
 *   ds:        ds
 *   list:      list
 *   count:     cou | coun | count
 *   order:     ord | orde | order
 *   sort:      so | sor | sort
 *   gsort:     gsort
 *   keep:      keep
 *   drop:      drop
 *   histogram: hist | histo | ... | histogram
 *
 * Notes:
 * - `by` and `bysort` are synonyms: groups are always formed in sorted
 *   order, so Stata's "not sorted" error for plain `by` cannot arise.
 *   Parenthesized variables (`bysort g (x):`) order observations within
 *   each group and do not define groups. Only BYABLE_COMMANDS are
 *   allowed. Stata also accepts `by: keep if` / `by: drop if`, but
 *   without `_n`/`_N` the prefix could not change the result, so it is
 *   rejected rather than silently ignored.
 * - `=` is accepted as a synonym for `==`, and `~=` for `!=`.
 * - `null` may only appear with `==`/`!=`.
 * - A bare `.` is Stata's numeric missing-value literal and maps to null:
 *   `x == .` / `x != .` test missingness, and the Stata idioms `x < .`
 *   (non-missing, since missing sorts above every value) and `x >= .`
 *   (missing) are recognized. `x <= .` and `x > .` are rejected because
 *   without extended missing values they are always/never true.
 * - `x == ""` / `x != ""` follow Stata's string-missing convention: they
 *   match (or exclude) both SQL NULL and the empty string.
 * - The keywords `if`, `null`, and `date` are contextual: a column whose
 *   name collides with one of them can always be referenced by backtick
 *   quoting (`if`, `null`, `date`).
 * - Date literals use the explicit deterministic form date("YYYY-MM-DD")
 *   or date("YYYY-MM-DD HH:MM[:SS]") (a 'T' separator is also accepted).
 * - Varlist names may contain Stata-style wildcards: `*` (any run of
 *   characters) and `?` (one character). A bare `*` means all variables.
 *   Wildcards are not allowed in expressions or backtick-quoted names.
 */

import {
  BYABLE_COMMANDS,
  CmpOp,
  ParsedByPrefix,
  ParsedCommand,
  ParsedCommandBody,
  ParsedExpr,
  ParsedOperand,
  SignedVarRef,
  VarRef,
} from "./ast";
import { StataCommandError } from "./errors";
import { lex, Token } from "./lexer";

type CommandName = ParsedCommandBody["kind"];

const COMMAND_FORMS: Array<{
  kind: CommandName;
  full: string;
  minPrefix: number;
}> = [
  { kind: "browse", full: "browse", minPrefix: 3 },
  { kind: "summarize", full: "summarize", minPrefix: 3 },
  { kind: "tabulate", full: "tabulate", minPrefix: 3 },
  { kind: "correlate", full: "correlate", minPrefix: 3 },
  { kind: "codebook", full: "codebook", minPrefix: 8 },
  { kind: "distinct", full: "distinct", minPrefix: 8 },
  { kind: "duplicates", full: "duplicates", minPrefix: 10 },
  { kind: "describe", full: "describe", minPrefix: 3 },
  { kind: "ds", full: "ds", minPrefix: 2 },
  { kind: "list", full: "list", minPrefix: 4 },
  { kind: "count", full: "count", minPrefix: 3 },
  { kind: "order", full: "order", minPrefix: 3 },
  { kind: "sort", full: "sort", minPrefix: 2 },
  { kind: "gsort", full: "gsort", minPrefix: 5 },
  { kind: "keep", full: "keep", minPrefix: 4 },
  { kind: "drop", full: "drop", minPrefix: 4 },
  { kind: "histogram", full: "histogram", minPrefix: 4 },
];

function matchCommandName(name: string): CommandName | null {
  const matches = COMMAND_FORMS.filter(
    (form) =>
      name.length >= form.minPrefix &&
      name.length <= form.full.length &&
      form.full.startsWith(name)
  );
  return matches.length === 1 ? matches[0].kind : null;
}

/** Stata's `duplicates` subcommands; only `report` is implemented here */
const DUPLICATES_SUBCOMMANDS = [
  "report",
  "examples",
  "list",
  "tag",
  "drop",
];

/** parsed command option, e.g. detail or bin(20) */
interface CmdOption {
  name: string;
  arg?: number;
  pos: number;
}

/** per-command option specification: canonical name -> abbreviation/arg */
interface OptionSpec {
  [canonical: string]: { minPrefix: number; hasArg: boolean };
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
    const by = this.parseOptionalByPrefix();
    const body = this.parseCommandBody(by);
    return by === undefined ? body : { ...body, by };
  }

  /**
   * Parse a `by varlist:` / `bysort varlist (sortvars):` /
   * `by varlist, sort:` prefix, if the line starts with one.
   */
  private parseOptionalByPrefix(): ParsedByPrefix | undefined {
    const tok = this.peek();
    const isBy =
      tok.type === "word" &&
      (tok.text === "by" ||
        (tok.text.length >= 3 && "bysort".startsWith(tok.text)));
    if (!isBy) {
      return undefined;
    }
    this.next();
    const variables = this.parseNameList();
    if (variables.length === 0) {
      this.error(`${tok.text} requires a varlist, e.g. ${tok.text} group:`);
    }
    let sortVariables: VarRef[] = [];
    const open = this.peek();
    if (open.type === "op" && open.text === "(") {
      this.next();
      sortVariables = this.parseNameList();
      if (sortVariables.length === 0) {
        this.error("expected a variable name inside ( )");
      }
      const close = this.peek();
      if (!(close.type === "op" && close.text === ")")) {
        this.error("expected ')'", close.pos);
      }
      this.next();
    }
    const comma = this.peek();
    if (comma.type === "op" && comma.text === ",") {
      this.next();
      const opt = this.peek();
      if (!(opt.type === "word" && opt.text === "sort")) {
        this.error(
          `option '${opt.text}' not recognized; allowed: sort`,
          opt.pos
        );
      }
      this.next();
    }
    const colon = this.peek();
    if (!(colon.type === "op" && colon.text === ":")) {
      this.error(
        `expected ':' after the ${tok.text} varlist, e.g. ${tok.text} group: sum x`,
        colon.pos
      );
    }
    this.next();
    return { variables, sortVariables };
  }

  /** variable names up to the next operator or end of input */
  private parseNameList(): VarRef[] {
    const vars: VarRef[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.type === "word" && tok.text !== "if") {
        vars.push({ name: tok.text, quoted: false, pos: tok.pos });
      } else if (tok.type === "quotedIdent") {
        vars.push({ name: tok.text, quoted: true, pos: tok.pos });
      } else {
        return vars;
      }
      this.next();
    }
  }

  private parseCommandBody(by: ParsedByPrefix | undefined): ParsedCommandBody {
    const first = this.peek();
    if (first.type === "eof") {
      this.error(
        by === undefined ? "empty command" : "expected a command after ':'"
      );
    }
    if (first.type !== "word") {
      this.error(
        "expected a command name (browse, sum, tab, codebook, ...)",
        first.pos
      );
    }
    const kind = matchCommandName(first.text);
    if (kind === null) {
      this.error(
        `unknown command '${first.text}': expected one of bro[wse], sum[marize], tab[ulate], cor[relate], codebook, distinct, duplicates, des[cribe], ds, list, cou[nt], ord[er], so[rt], gsort, keep, drop, hist[ogram]`,
        first.pos
      );
    }
    if (by !== undefined && (kind === "keep" || kind === "drop")) {
      this.error(
        `${kind} may not be combined with by; use ${kind} if without it`,
        first.pos
      );
    }
    if (by !== undefined && !BYABLE_COMMANDS.has(kind)) {
      this.error(`${kind} may not be combined with by`, first.pos);
    }
    this.next();

    switch (kind) {
      case "browse": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        this.expectNoOptions("browse");
        this.expectEof();
        return filter === undefined
          ? { kind, variables }
          : { kind, variables, filter };
      }
      case "summarize": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        const opts = this.parseOptions({
          detail: { minPrefix: 1, hasArg: false },
        });
        this.expectEof();
        const detail = opts.has("detail");
        return filter === undefined
          ? { kind, variables, detail }
          : { kind, variables, filter, detail };
      }
      case "tabulate": {
        const variable = this.parseSingleVar("tab");
        const filter = this.parseOptionalIf();
        const opts = this.parseOptions({
          missing: { minPrefix: 1, hasArg: false },
        });
        this.expectEof();
        const missing = opts.has("missing");
        return filter === undefined
          ? { kind, variable, missing }
          : { kind, variable, filter, missing };
      }
      case "correlate": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        const opts = this.parseOptions({
          covariance: { minPrefix: 3, hasArg: false },
        });
        this.expectEof();
        const covariance = opts.has("covariance");
        return filter === undefined
          ? { kind, variables, covariance }
          : { kind, variables, filter, covariance };
      }
      case "codebook": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        this.expectNoOptions("codebook");
        this.expectEof();
        return filter === undefined
          ? { kind, variables }
          : { kind, variables, filter };
      }
      case "distinct": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        const opts = this.parseOptions({
          missing: { minPrefix: 1, hasArg: false },
          joint: { minPrefix: 1, hasArg: false },
        });
        this.expectEof();
        const missing = opts.has("missing");
        const joint = opts.has("joint");
        return filter === undefined
          ? { kind, variables, missing, joint }
          : { kind, variables, filter, missing, joint };
      }
      case "duplicates": {
        this.parseDuplicatesSubcommand();
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        this.expectNoOptions("duplicates report");
        this.expectEof();
        return filter === undefined
          ? { kind, variables }
          : { kind, variables, filter };
      }
      case "describe": {
        const variables = this.parseVarlist();
        this.rejectIfClause("describe");
        this.expectNoOptions("describe");
        this.expectEof();
        return { kind, variables };
      }
      case "ds": {
        const variables = this.parseVarlist();
        this.rejectIfClause("ds");
        this.expectNoOptions("ds");
        this.expectEof();
        return { kind, variables };
      }
      case "list": {
        const variables = this.parseVarlist();
        const filter = this.parseOptionalIf();
        this.expectNoOptions("list");
        this.expectEof();
        return filter === undefined
          ? { kind, variables }
          : { kind, variables, filter };
      }
      case "count": {
        const stray = this.peek();
        if (stray.type === "word" && stray.text !== "if") {
          this.error("count does not take a varlist", stray.pos);
        }
        const filter = this.parseOptionalIf();
        this.expectNoOptions("count");
        this.expectEof();
        return filter === undefined ? { kind } : { kind, filter };
      }
      case "order": {
        const variables = this.parseVarlist();
        if (variables.length === 0) {
          this.error("order requires a varlist");
        }
        this.rejectIfClause("order");
        const opts = this.parseOptions({
          last: { minPrefix: 4, hasArg: false },
        });
        this.expectEof();
        return { kind, variables, last: opts.has("last") };
      }
      case "sort": {
        const variables = this.parseVarlist();
        if (variables.length === 0) {
          this.error("sort requires a varlist");
        }
        this.rejectIfClause("sort");
        this.expectNoOptions("sort");
        this.expectEof();
        return { kind, variables };
      }
      case "gsort": {
        const keys = this.parseSignedVarlist();
        if (keys.length === 0) {
          this.error("gsort requires at least one [+|-]varname");
        }
        this.expectNoOptions("gsort");
        this.expectEof();
        return { kind, keys };
      }
      case "keep":
      case "drop": {
        const ifTok = this.peek();
        if (ifTok.type === "word" && ifTok.text === "if") {
          const filter = this.parseOptionalIf()!;
          this.expectNoOptions(kind);
          this.expectEof();
          return { kind, variables: [], filter };
        }
        const variables = this.parseVarlist();
        if (variables.length === 0) {
          this.error(`${kind} requires a varlist or an if clause`);
        }
        const after = this.peek();
        if (after.type === "word" && after.text === "if") {
          this.error(
            `${kind} takes either a varlist or an if clause, not both`,
            after.pos
          );
        }
        this.expectNoOptions(kind);
        this.expectEof();
        return { kind, variables };
      }
      case "histogram": {
        const variable = this.parseSingleVar("histogram");
        const filter = this.parseOptionalIf();
        const opts = this.parseOptions({
          bin: { minPrefix: 3, hasArg: true },
        });
        this.expectEof();
        let bins: number | undefined;
        const binOpt = opts.get("bin");
        if (binOpt !== undefined) {
          if (
            binOpt.arg === undefined ||
            !Number.isInteger(binOpt.arg) ||
            binOpt.arg < 1
          ) {
            this.error(
              "bin() requires a positive integer, e.g. bin(20)",
              binOpt.pos
            );
          }
          bins = binOpt.arg;
        }
        if (filter === undefined && bins === undefined) {
          return { kind, variable };
        }
        if (filter === undefined) {
          return { kind, variable, bins };
        }
        if (bins === undefined) {
          return { kind, variable, filter };
        }
        return { kind, variable, filter, bins };
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

  private rejectIfClause(cmd: string): void {
    const tok = this.peek();
    if (tok.type === "word" && tok.text === "if") {
      this.error(`${cmd} does not support an if clause`, tok.pos);
    }
  }

  private expectNoOptions(cmd: string): void {
    const tok = this.peek();
    if (tok.type === "op" && tok.text === ",") {
      this.error(`${cmd} does not take options`, tok.pos);
    }
  }

  /**
   * Consume the `duplicates` subcommand. Only `report` is implemented;
   * Stata's other subcommands are recognized purely so they can be
   * rejected with a useful message rather than "unknown subcommand".
   */
  private parseDuplicatesSubcommand(): void {
    const tok = this.peek();
    if (tok.type !== "word" || tok.text === "if") {
      this.error(
        "duplicates requires a subcommand; only 'duplicates report' is supported",
        tok.pos
      );
    }
    this.next();
    // no two subcommand names share a first letter, so any prefix is
    // unambiguous
    const sub = DUPLICATES_SUBCOMMANDS.find((name) =>
      name.startsWith(tok.text)
    );
    if (sub === undefined) {
      this.error(
        `unknown duplicates subcommand '${tok.text}': expected r[eport]`,
        tok.pos
      );
    }
    if (sub !== "report") {
      this.error(
        `'duplicates ${sub}' is not supported; only 'duplicates report' is implemented`,
        tok.pos
      );
    }
  }

  /** parse a varlist that must contain exactly one name */
  private parseSingleVar(cmd: string): VarRef {
    const variables = this.parseVarlist();
    if (variables.length === 0) {
      this.error(`${cmd} requires a variable name`);
    }
    if (variables.length > 1) {
      this.error(`${cmd} accepts exactly one variable`, variables[1].pos);
    }
    return variables[0];
  }

  /**
   * parse zero or more variable names, stopping at `if`, ',', or end of
   * input
   */
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
      } else if (
        tok.type === "eof" ||
        (tok.type === "op" && tok.text === ",")
      ) {
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

  /** parse gsort-style signed varlist: ('+'|'-')? varname ... */
  private parseSignedVarlist(): SignedVarRef[] {
    const keys: SignedVarRef[] = [];
    for (;;) {
      let tok = this.peek();
      let descending = false;
      if (tok.type === "op" && (tok.text === "+" || tok.text === "-")) {
        descending = tok.text === "-";
        this.next();
        tok = this.peek();
        if (tok.type !== "word" && tok.type !== "quotedIdent") {
          this.error("expected a variable name after sign", tok.pos);
        }
      }
      if (tok.type === "word") {
        this.next();
        keys.push({
          ref: { name: tok.text, quoted: false, pos: tok.pos },
          descending,
        });
      } else if (tok.type === "quotedIdent") {
        this.next();
        keys.push({
          ref: { name: tok.text, quoted: true, pos: tok.pos },
          descending,
        });
      } else if (tok.type === "eof") {
        break;
      } else {
        this.error(
          `expected a variable name but found '${tok.text}'`,
          tok.pos
        );
      }
    }
    return keys;
  }

  /**
   * parse the option tail (',' option+) and validate against the
   * command's option spec, resolving abbreviations to canonical names.
   */
  private parseOptions(spec: OptionSpec): Map<string, CmdOption> {
    const out = new Map<string, CmdOption>();
    const tok = this.peek();
    if (!(tok.type === "op" && tok.text === ",")) {
      return out;
    }
    this.next();
    if (this.peek().type === "eof") {
      this.error("expected an option after ','");
    }
    for (;;) {
      const optTok = this.peek();
      if (optTok.type === "eof") {
        break;
      }
      if (optTok.type !== "word") {
        this.error(
          `expected an option name but found '${optTok.text}'`,
          optTok.pos
        );
      }
      this.next();
      let arg: number | undefined;
      const open = this.peek();
      if (open.type === "op" && open.text === "(") {
        this.next();
        const numTok = this.peek();
        if (numTok.type !== "number") {
          this.error(
            `expected a number in ${optTok.text}(...)`,
            numTok.pos
          );
        }
        this.next();
        arg = Number(numTok.text);
        const close = this.peek();
        if (!(close.type === "op" && close.text === ")")) {
          this.error("expected ')'", close.pos);
        }
        this.next();
      }
      // resolve against the spec
      const canonical = Object.keys(spec).find(
        (name) =>
          optTok.text.length >= spec[name].minPrefix &&
          optTok.text.length <= name.length &&
          name.startsWith(optTok.text)
      );
      if (canonical === undefined) {
        const allowed = Object.keys(spec)
          .map((name) =>
            spec[name].hasArg ? `${name}(#)` : name
          )
          .join(", ");
        this.error(
          `option '${optTok.text}' not recognized; allowed: ${
            allowed === "" ? "(none)" : allowed
          }`,
          optTok.pos
        );
      }
      if (spec[canonical].hasArg && arg === undefined) {
        this.error(
          `option '${canonical}' requires a numeric argument, e.g. ${canonical}(10)`,
          optTok.pos
        );
      }
      if (!spec[canonical].hasArg && arg !== undefined) {
        this.error(
          `option '${canonical}' does not take an argument`,
          optTok.pos
        );
      }
      if (out.has(canonical)) {
        this.error(`option '${canonical}' given twice`, optTok.pos);
      }
      out.set(canonical, { name: canonical, arg, pos: optTok.pos });
    }
    return out;
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
    const lhsRes = this.parseOperandExt();
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
    let op = normalizeRelOp(opTok.text);
    const rhsRes = this.parseOperandExt();
    let lhs = lhsRes.operand;
    let rhs = rhsRes.operand;

    // Stata numeric missing: normalize the '.' literal to a null
    // comparison. Mirror first so the dot sits on the rhs, then map the
    // missing-sorts-last idioms onto ==/!=.
    let dotRhs = rhsRes.dot;
    if (lhsRes.dot && !rhsRes.dot) {
      [lhs, rhs] = [rhs, lhs];
      op = MIRRORED_OP[op];
      dotRhs = true;
    }
    if (dotRhs) {
      switch (op) {
        case "==":
        case "!=":
          break;
        case "<":
          // every non-missing value is below missing
          op = "!=";
          break;
        case ">=":
          // only missing is at or above missing
          op = "==";
          break;
        default:
          this.error(
            `'${opTok.text} .' is always or never true; use == . (missing), != . or < . (non-missing), or >= . (missing)`,
            opTok.pos
          );
      }
    }

    if (lhs.kind === "null" || rhs.kind === "null") {
      if (op !== "==" && op !== "!=") {
        this.error(
          `null can only be compared with == or !=, not '${opTok.text}'`,
          opTok.pos
        );
      }
    }

    // Stata string missing: "" matches both SQL NULL and the empty string
    const lhsEmpty = isEmptyString(lhs);
    const rhsEmpty = isEmptyString(rhs);
    if ((op === "==" || op === "!=") && lhsEmpty !== rhsEmpty) {
      const subject = lhsEmpty ? rhs : lhs;
      const empty: ParsedOperand = { kind: "string", value: "" };
      const cmpNull: ParsedExpr = {
        kind: "cmp",
        op,
        lhs: subject,
        rhs: { kind: "null" },
      };
      const cmpEmpty: ParsedExpr = { kind: "cmp", op, lhs: subject, rhs: empty };
      return op === "=="
        ? { kind: "or", args: [cmpNull, cmpEmpty] }
        : { kind: "and", args: [cmpNull, cmpEmpty] };
    }

    return { kind: "cmp", op, lhs, rhs };
  }

  /**
   * Parse an operand, tracking whether it was written as the bare '.'
   * missing-value literal (which parses as a null literal).
   */
  private parseOperandExt(): { operand: ParsedOperand; dot: boolean } {
    const tok = this.peek();
    if (tok.type === "op" && tok.text === ".") {
      this.next();
      return { operand: { kind: "null" }, dot: true };
    }
    return { operand: this.parseOperand(), dot: false };
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

/** op with sides swapped: a OP b === b MIRRORED_OP[OP] a */
const MIRRORED_OP: { [op in CmpOp]: CmpOp } = {
  "==": "==",
  "!=": "!=",
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

function isEmptyString(op: ParsedOperand): boolean {
  return op.kind === "string" && op.value === "";
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
