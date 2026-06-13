/**
 * Tests for the expanded command language: options, wildcards, and the
 * describe/ds/list/count/order/sort/gsort/keep/drop/histogram commands
 * plus summarize-detail planning.
 */
import {
  ColumnMetaMap,
  DuckDBDialect,
  Schema,
  tableQuery,
} from "reltab";
import { parseCommand } from "../src/stataCommand/parser";
import { resolveCommand } from "../src/stataCommand/resolve";
import {
  combineFilters,
  defaultHistogramBins,
  GridPlan,
  HistogramPlan,
  ListPlan,
  negateExpr,
  planCommand,
  PlanContext,
  SumDetailPlan,
  SummarizePlan,
  TabulatePlan,
  exprToSqlWhere,
} from "../src/stataCommand/sql";
import { Expr } from "../src/stataCommand/ast";

const COLUMNS: Array<[string, string]> = [
  ["price", "INTEGER"],
  ["price_per_unit", "DOUBLE"],
  ["mpg", "INTEGER"],
  ["make", "VARCHAR"],
  ["model", "VARCHAR"],
  ["d", "DATE"],
];

function mkSchema(cols: Array<[string, string]> = COLUMNS): Schema {
  const cmMap: ColumnMetaMap = {};
  for (const [colId, columnType] of cols) {
    cmMap[colId] = { displayName: colId, columnType };
  }
  return new Schema(
    DuckDBDialect,
    cols.map(([colId]) => colId),
    cmMap
  );
}

const schema = mkSchema();
const allCols = schema.columns;

const mkCtx = (over: Partial<PlanContext> = {}): PlanContext => ({
  schema,
  dialect: DuckDBDialect,
  baseQuery: tableQuery("t"),
  sessionFilter: null,
  sortKey: [],
  ...over,
});

const resolve = (input: string) =>
  resolveCommand(parseCommand(input), allCols);

const plan = (input: string, over: Partial<PlanContext> = {}) =>
  planCommand(resolve(input), mkCtx(over));

/* ------------------------------ parsing ------------------------------ */

describe("options parsing", () => {
  test("sum detail and abbreviations", () => {
    expect((parseCommand("sum price, detail") as any).detail).toBe(true);
    expect((parseCommand("sum price, d") as any).detail).toBe(true);
    expect((parseCommand("sum price") as any).detail).toBe(false);
    expect((parseCommand("sum price if mpg > 20, d") as any).detail).toBe(
      true
    );
  });

  test("tab missing option", () => {
    expect((parseCommand("tab make, missing") as any).missing).toBe(true);
    expect((parseCommand("tab make, m") as any).missing).toBe(true);
    expect((parseCommand("tab make") as any).missing).toBe(false);
  });

  test("histogram bin option", () => {
    expect((parseCommand("hist price, bin(20)") as any).bins).toBe(20);
    expect((parseCommand("hist price") as any).bins).toBeUndefined();
    expect(() => parseCommand("hist price, bin()")).toThrow(
      "expected a number"
    );
    expect(() => parseCommand("hist price, bin(0)")).toThrow(
      "positive integer"
    );
    expect(() => parseCommand("hist price, bin(2.5)")).toThrow(
      "positive integer"
    );
  });

  test("unknown and malformed options", () => {
    expect(() => parseCommand("sum price, bogus")).toThrow(
      "option 'bogus' not recognized"
    );
    expect(() => parseCommand("sum price, detail(3)")).toThrow(
      "does not take an argument"
    );
    expect(() => parseCommand("bro price, detail")).toThrow(
      "browse does not take options"
    );
    expect(() => parseCommand("sum price,")).toThrow(
      "expected an option after ','"
    );
    expect(() => parseCommand("sum price, d d")).toThrow(
      "option 'detail' given twice"
    );
  });

  test("order last option", () => {
    expect((parseCommand("order make, last") as any).last).toBe(true);
    expect((parseCommand("order make") as any).last).toBe(false);
  });
});

describe("new command forms", () => {
  test("count", () => {
    expect(parseCommand("count")).toEqual({ kind: "count" });
    expect(parseCommand("cou if mpg > 2")).toMatchObject({ kind: "count" });
    expect(() => parseCommand("count price")).toThrow(
      "count does not take a varlist"
    );
  });

  test("keep/drop dual forms", () => {
    expect(parseCommand("keep price mpg")).toMatchObject({
      kind: "keep",
      variables: [{ name: "price" }, { name: "mpg" }],
    });
    expect(parseCommand("drop if mpg < 10")).toMatchObject({
      kind: "drop",
      variables: [],
    });
    expect(() => parseCommand("keep")).toThrow(
      "keep requires a varlist or an if clause"
    );
    expect(() => parseCommand("keep price if mpg > 1")).toThrow(
      "keep takes either a varlist or an if clause, not both"
    );
  });

  test("gsort signed keys", () => {
    expect(parseCommand("gsort -price make +mpg")).toMatchObject({
      kind: "gsort",
      keys: [
        { ref: { name: "price" }, descending: true },
        { ref: { name: "make" }, descending: false },
        { ref: { name: "mpg" }, descending: false },
      ],
    });
    expect(() => parseCommand("gsort")).toThrow(
      "gsort requires at least one"
    );
    expect(() => parseCommand("gsort -")).toThrow(
      "expected a variable name after sign"
    );
  });

  test("sort and order", () => {
    expect(parseCommand("sort price mpg")).toMatchObject({ kind: "sort" });
    expect(parseCommand("so price")).toMatchObject({ kind: "sort" });
    expect(() => parseCommand("sort")).toThrow("sort requires a varlist");
    expect(() => parseCommand("order")).toThrow("order requires a varlist");
    expect(() => parseCommand("sort price if mpg > 1")).toThrow(
      "sort does not support an if clause"
    );
  });

  test("describe, ds, list", () => {
    expect(parseCommand("des")).toMatchObject({ kind: "describe" });
    expect(parseCommand("describe price")).toMatchObject({
      kind: "describe",
    });
    expect(parseCommand("ds")).toMatchObject({ kind: "ds" });
    expect(parseCommand("list price if mpg > 1")).toMatchObject({
      kind: "list",
    });
    expect(parseCommand("hist price if mpg > 1, bin(3)")).toMatchObject({
      kind: "histogram",
      bins: 3,
    });
  });
});

/* ---------------------------- wildcards ------------------------------ */

describe("varlist wildcards", () => {
  test("prefix star expands in schema order", () => {
    expect(resolve("sum price*")).toMatchObject({
      variables: ["price", "price_per_unit"],
    });
  });

  test("question mark matches one character", () => {
    expect(resolve("bro m?g")).toMatchObject({ variables: ["mpg"] });
  });

  test("bare star is all variables", () => {
    expect(resolve("bro *")).toMatchObject({ variables: allCols });
  });

  test("interior star", () => {
    expect(resolve("ds *p*")).toMatchObject({
      variables: ["price", "price_per_unit", "mpg"],
    });
  });

  test("overlapping patterns dedupe silently", () => {
    expect(resolve("sum price* *unit")).toMatchObject({
      variables: ["price", "price_per_unit"],
    });
  });

  test("no match errors", () => {
    expect(() => resolve("sum z*")).toThrow("no variables match pattern");
  });

  test("wildcards rejected in expressions and single-var commands", () => {
    expect(() => resolve("sum price if m* > 1")).toThrow(
      "wildcards are not allowed here"
    );
    expect(() => resolve("tab m*")).toThrow("wildcards are not allowed here");
    expect(() => resolve("hist p*")).toThrow(
      "wildcards are not allowed here"
    );
  });
});

/* --------------------------- filter algebra -------------------------- */

describe("filter combination and negation", () => {
  const e1: Expr = {
    kind: "cmp",
    op: ">",
    lhs: { kind: "var", name: "mpg" },
    rhs: { kind: "number", value: 20 },
  };
  const e2: Expr = {
    kind: "cmp",
    op: "==",
    lhs: { kind: "var", name: "make" },
    rhs: { kind: "string", value: "AMC" },
  };

  test("combineFilters flattens ANDs", () => {
    expect(combineFilters(null, undefined)).toBeUndefined();
    expect(combineFilters(e1, null)).toBe(e1);
    const both = combineFilters(e1, e2)!;
    expect(both.kind).toBe("and");
    const three = combineFilters(both, e1)!;
    expect(three).toMatchObject({ kind: "and" });
    expect((three as any).args.length).toBe(3);
  });

  test("negateExpr applies De Morgan and inverts comparisons", () => {
    expect(exprToSqlWhere(negateExpr(e1), DuckDBDialect)).toBe(`"mpg" <= 20`);
    const orExpr: Expr = { kind: "or", args: [e1, e2] };
    expect(exprToSqlWhere(negateExpr(orExpr), DuckDBDialect)).toBe(
      `"mpg" <= 20 AND "make" <> 'AMC'`
    );
  });
});

/* ------------------------------ planning ----------------------------- */

describe("session filter in plans", () => {
  const session: Expr = {
    kind: "cmp",
    op: ">",
    lhs: { kind: "var", name: "mpg" },
    rhs: { kind: "number", value: 15 },
  };

  test("stats commands combine session and if filters", () => {
    const p = plan("sum price if make == 'AMC'", {
      sessionFilter: session,
    }) as SummarizePlan;
    expect(p.sql).toContain(`WHERE ("mpg" > 15 AND "make" = 'AMC')`);
  });

  test("count uses the session filter alone", () => {
    const p = plan("count", { sessionFilter: session }) as any;
    expect(p.sql).toContain(`WHERE ("mpg" > 15)`);
  });
});

describe("grid plans", () => {
  test("keep varlist preserves view order and prunes sort keys", () => {
    const p = plan("keep mpg price", {
      sortKey: [
        ["make", true],
        ["price", false],
      ],
    }) as GridPlan;
    expect(p.op).toBe("keep");
    // view (schema) order, not command order
    expect(p.displayColumns).toEqual(["price", "mpg"]);
    expect(p.sortKey).toEqual([["price", false]]);
    expect(p.sessionChanged).toBe(false);
    expect(p.sql).toContain(`"price"`);
  });

  test("drop varlist removes columns", () => {
    const p = plan("drop m*") as GridPlan;
    expect(p.displayColumns).toEqual(["price", "price_per_unit", "d"]);
  });

  test("drop everything is an error", () => {
    expect(() => plan("drop *")).toThrow(
      "drop would remove every variable from the view"
    );
  });

  test("keep if extends the session filter", () => {
    const p = plan("keep if mpg > 20") as GridPlan;
    expect(p.sessionChanged).toBe(true);
    expect(p.sessionFilter).not.toBeNull();
    expect(exprToSqlWhere(p.sessionFilter!, DuckDBDialect)).toBe(
      `"mpg" > 20`
    );
    expect(p.gridFilterExp).not.toBeNull();
    expect(p.sql).toContain("WHERE");
  });

  test("drop if negates into the session filter", () => {
    const p = plan("drop if mpg > 20") as GridPlan;
    expect(exprToSqlWhere(p.sessionFilter!, DuckDBDialect)).toBe(
      `"mpg" <= 20`
    );
  });

  test("order moves to front; , last moves to end", () => {
    const front = plan("order make model") as GridPlan;
    expect(front.displayColumns).toEqual([
      "make",
      "model",
      "price",
      "price_per_unit",
      "mpg",
      "d",
    ]);
    const back = plan("order price*, last") as GridPlan;
    expect(back.displayColumns).toEqual([
      "mpg",
      "make",
      "model",
      "d",
      "price",
      "price_per_unit",
    ]);
  });

  test("sort and gsort produce sort keys and ORDER BY sql", () => {
    const s = plan("sort make price") as GridPlan;
    expect(s.sortKey).toEqual([
      ["make", true],
      ["price", true],
    ]);
    expect(s.sql).toContain("ORDER BY");
    const g = plan("gsort -price make") as GridPlan;
    expect(g.sortKey).toEqual([
      ["price", false],
      ["make", true],
    ]);
  });
});

describe("tabulate missing option", () => {
  test("missing keeps nulls and drops the not-null condition", () => {
    const p = plan("tab make, missing") as TabulatePlan;
    expect(p.sql).not.toContain("IS NOT NULL");
    const p2 = plan("tab make") as TabulatePlan;
    expect(p2.sql).toContain(`"make" IS NOT NULL`);
  });
});

describe("list and histogram plans", () => {
  test("list caps rows and carries total", () => {
    const p = plan("list price make") as ListPlan;
    expect(p.sql).toContain("LIMIT 200");
    expect(p.sql).toContain("count(*) OVER () AS n_total");
  });

  test("histogram requires numeric", () => {
    expect(() => plan("hist make")).toThrow(
      "histogram requires a numeric variable"
    );
  });

  test("histogram bins SQL clamps the top bin", () => {
    const p = plan("hist price, bin(4)") as HistogramPlan;
    const binsSql = p.mkBinsSql(0, 2.5, 4);
    expect(binsSql).toContain(
      `LEAST(CAST(floor(("price" - 0) / 2.5) AS INTEGER), 3) AS bin`
    );
    expect(p.statsSql).toContain(`"price" IS NOT NULL`);
  });

  test("default bin rule: min(sqrt(N), 10*log10(N))", () => {
    expect(defaultHistogramBins(5)).toBe(2); // sqrt(5) ~ 2.24
    expect(defaultHistogramBins(100)).toBe(10);
    expect(defaultHistogramBins(10000)).toBe(40); // 10*log10 = 40 < 100
    expect(defaultHistogramBins(1)).toBe(1);
  });
});

describe("summarize detail plan", () => {
  test("two-phase: shared N/mean scan then per-variable detail", () => {
    const p = plan("sum price mpg if mpg > 1, d") as SumDetailPlan;
    expect(p.kind).toBe("sumDetail");
    expect(p.variables).toEqual(["price", "mpg"]);
    expect(p.phase1Sql).toContain(`count("price") AS n_0`);
    expect(p.phase1Sql).toContain(`CAST(avg("mpg") AS DOUBLE) AS mean_1`);
    expect(p.phase1Sql).toContain(`WHERE ("mpg" > 1)`);

    const detail = p.mkDetailSql("price", 5, 3.2);
    // Stata percentile: N=5, p50 -> h=2.5 -> x_3 = quantile_disc at (3-0.5)/5
    expect(detail).toContain(
      `CAST(quantile_disc("price", 0.5) AS DOUBLE) AS p50`
    );
    // p25 -> h=1.25 -> x_2 -> (2-0.5)/5 = 0.3
    expect(detail).toContain(
      `CAST(quantile_disc("price", 0.3) AS DOUBLE) AS p25`
    );
    // central moments about the supplied mean
    expect(detail).toContain(`avg(pow("price" - 3.2, 3))`);
    expect(detail).toContain(`small_1`);
    expect(detail).toContain(`large_4`);
  });

  test("integer-h percentile averages adjacent order stats", () => {
    const p = plan("sum price, d") as SumDetailPlan;
    // N=4, p25 -> h=1 exactly -> (x_1 + x_2)/2
    const detail = p.mkDetailSql("price", 4, 10);
    expect(detail).toContain(
      `CAST((quantile_disc("price", 0.125) + quantile_disc("price", 0.375)) / 2.0 AS DOUBLE) AS p25`
    );
  });

  test("non-numeric variables are excluded; all-string varlist errors", () => {
    const p = plan("sum, d") as SumDetailPlan;
    expect(p.variables).toEqual(["price", "price_per_unit", "mpg"]);
    expect(() => plan("sum make, d")).toThrow(
      "requires at least one numeric variable"
    );
  });
});
