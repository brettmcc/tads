/**
 * Table-driven tests for the Stata command lexer and parser
 * (schema-independent layer).
 */
import { ParsedCommand } from "../src/stataCommand/ast";
import { StataCommandError } from "../src/stataCommand/errors";
import { lex } from "../src/stataCommand/lexer";
import { parseCommand } from "../src/stataCommand/parser";

/* ----------------------------- lexer ----------------------------- */

describe("lexer", () => {
  test("words, numbers, strings, operators", () => {
    const toks = lex(`bro a if b >= 1.5 & s == "hi"`);
    expect(toks.map((t) => [t.type, t.text])).toEqual([
      ["word", "bro"],
      ["word", "a"],
      ["word", "if"],
      ["word", "b"],
      ["op", ">="],
      ["number", "1.5"],
      ["op", "&"],
      ["word", "s"],
      ["op", "=="],
      ["string", "hi"],
      ["eof", ""],
    ]);
  });

  test("string escapes: doubled quotes", () => {
    expect(lex(`'it''s'`)[0]).toMatchObject({
      type: "string",
      text: "it's",
    });
    expect(lex(`"say ""hi"""`)[0]).toMatchObject({
      type: "string",
      text: 'say "hi"',
    });
  });

  test("backtick-quoted identifiers", () => {
    expect(lex("`has space`")[0]).toMatchObject({
      type: "quotedIdent",
      text: "has space",
    });
    expect(lex('`quote"name`')[0]).toMatchObject({
      type: "quotedIdent",
      text: 'quote"name',
    });
    expect(lex("`back``tick`")[0]).toMatchObject({
      type: "quotedIdent",
      text: "back`tick",
    });
  });

  test("numbers", () => {
    expect(lex("12")[0]).toMatchObject({ type: "number", text: "12" });
    expect(lex(".5")[0]).toMatchObject({ type: "number", text: ".5" });
    expect(lex("1e9")[0]).toMatchObject({ type: "number", text: "1e9" });
    expect(lex("2.5E-3")[0]).toMatchObject({ type: "number", text: "2.5E-3" });
  });

  const lexErrors: Array<[string, string]> = [
    ["bro a if s == 'oops", "unterminated string literal"],
    ["bro `oops", "unterminated quoted variable name"],
    ["bro ``", "empty quoted variable name"],
    ["sum a if b == 1.5x", "invalid number"],
    ["sum a if b # 2", "unexpected character '#'"],
  ];
  test.each(lexErrors)("lex error: %s", (input, msgPart) => {
    expect(() => lex(input)).toThrow(StataCommandError);
    expect(() => lex(input)).toThrow(msgPart);
  });
});

/* ----------------------------- parser ---------------------------- */

const v = (name: string, pos: number, quoted = false) => ({
  name,
  quoted,
  pos,
});

describe("command recognition and abbreviations", () => {
  const good: Array<[string, ParsedCommand["kind"]]> = [
    ["bro a", "browse"],
    ["brow a", "browse"],
    ["brows a", "browse"],
    ["browse a", "browse"],
    ["sum a", "summarize"],
    ["summ a", "summarize"],
    ["summarize a", "summarize"],
    ["tab a", "tabulate"],
    ["tabu a", "tabulate"],
    ["tabulate a", "tabulate"],
    ["codebook a", "codebook"],
  ];
  test.each(good)("'%s' -> %s", (input, kind) => {
    expect(parseCommand(input).kind).toBe(kind);
  });

  const bad: string[] = ["b a", "br a", "su a", "ta a", "code a", "list a", "summarizes a", "browsee a"];
  test.each(bad)("unknown command: '%s'", (input) => {
    expect(() => parseCommand(input)).toThrow(/unknown command|empty command/);
  });

  test("empty input", () => {
    expect(() => parseCommand("")).toThrow("empty command");
    expect(() => parseCommand("   ")).toThrow("empty command");
  });
});

describe("varlists", () => {
  test("multiple variables in order", () => {
    const cmd = parseCommand("bro a b c");
    expect(cmd).toEqual({
      kind: "browse",
      variables: [v("a", 4), v("b", 6), v("c", 8)],
    });
  });

  test("empty varlist allowed for browse/sum/codebook", () => {
    expect(parseCommand("bro")).toEqual({ kind: "browse", variables: [] });
    expect(parseCommand("sum")).toEqual({ kind: "summarize", variables: [] });
    expect(parseCommand("codebook")).toEqual({
      kind: "codebook",
      variables: [],
    });
  });

  test("quoted variable names", () => {
    const cmd = parseCommand("bro `has space` `select` `quote\"name`");
    expect(cmd).toEqual({
      kind: "browse",
      variables: [
        v("has space", 4, true),
        v("select", 16, true),
        v('quote"name', 25, true),
      ],
    });
  });

  test("tab requires exactly one variable", () => {
    expect(() => parseCommand("tab")).toThrow("tab requires a variable name");
    expect(() => parseCommand("tab a b")).toThrow(
      "tab accepts exactly one variable"
    );
  });

  test("codebook rejects if clause", () => {
    expect(() => parseCommand("codebook a if a > 1")).toThrow(
      "codebook does not support an if clause"
    );
  });
});

describe("if expressions", () => {
  test("simple comparison", () => {
    const cmd = parseCommand("sum a if c > 2");
    expect(cmd).toEqual({
      kind: "summarize",
      variables: [v("a", 4)],
      filter: {
        kind: "cmp",
        op: ">",
        lhs: { kind: "var", ref: v("c", 9) },
        rhs: { kind: "number", value: 2 },
      },
    });
  });

  const opCases: Array<[string, string]> = [
    ["=", "=="],
    ["==", "=="],
    ["!=", "!="],
    ["~=", "!="],
    ["<", "<"],
    ["<=", "<="],
    [">", ">"],
    [">=", ">="],
  ];
  test.each(opCases)("operator '%s' normalizes to '%s'", (op, normalized) => {
    const cmd = parseCommand(`bro a if b ${op} 1`) as any;
    expect(cmd.filter.op).toBe(normalized);
  });

  test("null comparisons", () => {
    const eq = parseCommand("bro if a == null") as any;
    expect(eq.filter).toEqual({
      kind: "cmp",
      op: "==",
      lhs: { kind: "var", ref: v("a", 7) },
      rhs: { kind: "null" },
    });
    const ne = parseCommand("bro if a != null") as any;
    expect(ne.filter.op).toBe("!=");
    expect(() => parseCommand("bro if a > null")).toThrow(
      "null can only be compared with == or !="
    );
  });

  test("string literals with embedded quotes", () => {
    const sq = parseCommand(`bro if s == 'it''s'`) as any;
    expect(sq.filter.rhs).toEqual({ kind: "string", value: "it's" });
    const dq = parseCommand(`bro if s == "say ""hi"""`) as any;
    expect(dq.filter.rhs).toEqual({ kind: "string", value: 'say "hi"' });
  });

  test("date literals", () => {
    const d = parseCommand(`bro if d >= date("2026-06-12")`) as any;
    expect(d.filter.rhs).toEqual({
      kind: "date",
      value: "2026-06-12",
      hasTime: false,
    });
    const ts = parseCommand(`bro if ts < date("2026-06-12 10:30:00")`) as any;
    expect(ts.filter.rhs).toEqual({
      kind: "date",
      value: "2026-06-12 10:30:00",
      hasTime: true,
    });
    expect(() => parseCommand(`bro if d > date("12/06/2026")`)).toThrow(
      "invalid date literal"
    );
    expect(() => parseCommand(`bro if d > date("2026-02-31")`)).toThrow(
      "no such date"
    );
    expect(() => parseCommand(`bro if d > date(2026)`)).toThrow(
      "date(...) requires a quoted literal"
    );
  });

  test("negative numbers", () => {
    const cmd = parseCommand("sum a if b > -1.5") as any;
    expect(cmd.filter.rhs).toEqual({ kind: "number", value: -1.5 });
  });

  test("boolean operators and flattening", () => {
    const cmd = parseCommand("bro if a > 1 & b < 2 & c == 3") as any;
    expect(cmd.filter.kind).toBe("and");
    expect(cmd.filter.args.length).toBe(3);
  });

  test("precedence: & binds tighter than |", () => {
    const cmd = parseCommand("bro if a > 1 | b < 2 & c == 3") as any;
    expect(cmd.filter.kind).toBe("or");
    expect(cmd.filter.args.length).toBe(2);
    expect(cmd.filter.args[0].kind).toBe("cmp");
    expect(cmd.filter.args[1].kind).toBe("and");
    expect(cmd.filter.args[1].args.length).toBe(2);
  });

  test("parentheses override precedence", () => {
    const cmd = parseCommand("bro if (a > 1 | b < 2) & c == 3") as any;
    expect(cmd.filter.kind).toBe("and");
    expect(cmd.filter.args[0].kind).toBe("or");
    expect(cmd.filter.args[1].kind).toBe("cmp");
  });

  test("nested parentheses", () => {
    const cmd = parseCommand(
      "bro if ((a > 1 | b < 2) & c == 3) | s == 'x'"
    ) as any;
    expect(cmd.filter.kind).toBe("or");
    expect(cmd.filter.args[0].kind).toBe("and");
    expect(cmd.filter.args[0].args[0].kind).toBe("or");
  });

  test("comparisons between two columns", () => {
    const cmd = parseCommand("bro if a > b") as any;
    expect(cmd.filter.lhs).toEqual({ kind: "var", ref: v("a", 7) });
    expect(cmd.filter.rhs).toEqual({ kind: "var", ref: v("b", 11) });
  });

  test("quoted identifier in expression", () => {
    const cmd = parseCommand("bro if `has space` > 10") as any;
    expect(cmd.filter.lhs).toEqual({
      kind: "var",
      ref: v("has space", 7, true),
    });
  });

  const parseErrors: Array<[string, string | RegExp]> = [
    ["sum a if", "expected an expression after 'if'"],
    ["sum a if c >", "unexpected end of input"],
    ["sum a if > 2", "expected a value or variable"],
    ["sum a if c 2", "expected a comparison operator"],
    ["sum a if (c > 2", "expected ')'"],
    ["sum a if c > 2)", "unexpected input after end of command"],
    ["sum a if c > 2 extra == 1", "unexpected input after end of command"],
    ["sum a if c > 2 &", "unexpected end of input"],
    ["sum a if & c > 2", "expected a value or variable"],
    ["bro a 5", "expected a variable name but found '5'"],
  ];
  test.each(parseErrors)("parse error: %s", (input, msgPart) => {
    expect(() => parseCommand(input)).toThrow(msgPart);
  });

  test("errors carry source positions", () => {
    try {
      parseCommand("sum a if c 2");
      fail("expected parse error");
    } catch (e) {
      const err = e as StataCommandError;
      expect(err.pos).toBe(11);
    }
  });
});
