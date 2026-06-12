/**
 * Schema resolution tests: exact matches, unique-prefix abbreviation,
 * ambiguity, unknown variables, and quoted identifiers.
 */
import { StataCommandError } from "../src/stataCommand/errors";
import { parseCommand } from "../src/stataCommand/parser";
import { resolveCommand } from "../src/stataCommand/resolve";

const COLUMNS = [
  "a",
  "b",
  "c",
  "s",
  "has space",
  "select",
  'quote"name',
  "d",
  "ts",
  "total",
  "total_amount",
];

const resolve = (input: string) =>
  resolveCommand(parseCommand(input), COLUMNS);

describe("variable resolution", () => {
  test("exact matches", () => {
    expect(resolve("bro a b c")).toEqual({
      kind: "browse",
      variables: ["a", "b", "c"],
    });
  });

  test("empty varlist expands to all columns in schema order", () => {
    expect(resolve("bro")).toEqual({ kind: "browse", variables: COLUMNS });
    expect(resolve("sum")).toEqual({
      kind: "summarize",
      variables: COLUMNS,
    });
    expect(resolve("codebook")).toEqual({
      kind: "codebook",
      variables: COLUMNS,
    });
  });

  test("unique prefix abbreviation", () => {
    expect(resolve("bro se")).toEqual({
      kind: "browse",
      variables: ["select"],
    });
    expect(resolve("bro ha")).toEqual({
      kind: "browse",
      variables: ["has space"],
    });
    expect(resolve("tab q")).toEqual({
      kind: "tabulate",
      variable: 'quote"name',
    });
  });

  test("exact match wins over prefix ambiguity", () => {
    // 'total' is both a column and a prefix of 'total_amount'
    expect(resolve("bro total")).toEqual({
      kind: "browse",
      variables: ["total"],
    });
  });

  test("ambiguous prefix lists candidates", () => {
    expect(() => resolve("bro tot")).toThrow(
      "ambiguous variable 'tot': matches total, total_amount"
    );
  });

  test("unknown variable", () => {
    expect(() => resolve("bro nope")).toThrow("unknown variable 'nope'");
  });

  test("quoted names resolve exactly, never by prefix", () => {
    expect(resolve("bro `has space`")).toEqual({
      kind: "browse",
      variables: ["has space"],
    });
    expect(() => resolve("bro `tot`")).toThrow("unknown variable 'tot'");
  });

  test("duplicate variables rejected", () => {
    expect(() => resolve("sum a a")).toThrow(
      "variable 'a' appears more than once"
    );
    // duplicate via abbreviation
    expect(() => resolve("sum select se")).toThrow(
      "variable 'select' appears more than once"
    );
  });

  test("variables in filter expressions are resolved", () => {
    const cmd = resolve("sum a if se == 'x' & total_ > 5") as any;
    expect(cmd.filter.args[0].lhs).toEqual({ kind: "var", name: "select" });
    expect(cmd.filter.args[1].lhs).toEqual({
      kind: "var",
      name: "total_amount",
    });
  });

  test("unknown variable in filter has position", () => {
    try {
      resolve("sum a if bogus > 1");
      fail("expected resolve error");
    } catch (e) {
      const err = e as StataCommandError;
      expect(err.message).toContain("unknown variable 'bogus'");
      expect(err.pos).toBe(9);
    }
  });
});
