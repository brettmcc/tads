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
  SCATTER_POINT_LIMIT,
  ScatterPlan,
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

describe("scatter plan", () => {
  test("counts usable observations, then selects the points", () => {
    const p = plan("scatter price mpg d if mpg > 1") as ScatterPlan;
    expect(p).toMatchObject({
      kind: "scatter",
      yVariables: ["price", "mpg"],
      xVariable: "d",
      xAxis: "date",
      yAxis: "numeric",
    });
    const where = `WHERE ("mpg" > 1) AND "d" IS NOT NULL AND ("price" IS NOT NULL OR "mpg" IS NOT NULL)`;
    expect(p.countSql).toContain("SELECT count(*) AS n");
    expect(p.countSql).toContain(where);
    const all = p.mkPointsSql(false);
    expect(all).toContain(
      `SELECT CAST(epoch_ms(CAST("d" AS TIMESTAMP)) AS DOUBLE) AS x,`
    );
    expect(all).toContain(`CAST("price" AS DOUBLE) AS y0,`);
    expect(all).toContain(`CAST("mpg" AS DOUBLE) AS y1`);
    expect(all).toContain(where);
    expect(all).not.toContain("SAMPLE");
    // the sample wraps the filtered rows, so it is drawn after the WHERE
    const sampled = p.mkPointsSql(true);
    expect(sampled).toContain(all.split("\n").map((l) => "  " + l).join("\n"));
    expect(sampled).toMatch(
      new RegExp(
        `\\)\\nUSING SAMPLE reservoir\\(${SCATTER_POINT_LIMIT} ROWS\\) REPEATABLE \\(1\\)$`
      )
    );
  });

  test("a single y needs no OR", () => {
    const p = plan("sc price mpg") as ScatterPlan;
    expect(p.countSql).toContain(
      `WHERE "mpg" IS NOT NULL AND "price" IS NOT NULL`
    );
  });

  test("rejects strings and mixed numeric/date y variables", () => {
    expect(() => plan("sc make price")).toThrow(
      "scatter requires numeric or date variables ('make' is VARCHAR)"
    );
    expect(() => plan("sc price d mpg")).toThrow(
      "scatter y variables must be all numeric or all dates"
    );
  });
});

describe("summarize detail plan", () => {
  test("one query per variable reads the order statistics off its ranks", () => {
    const p = plan("sum price mpg if mpg > 1, d") as SumDetailPlan;
    expect(p.kind).toBe("sumDetail");
    expect(p.variables).toEqual(["price", "mpg"]);
    expect(p.sqls).toHaveLength(2);
    const [price, mpg] = p.sqls;
    expect(price).toContain(`row_number() OVER (ORDER BY "price") AS r`);
    expect(price).toContain(`count(*) OVER () AS n`);
    expect(price).toContain(`WHERE ("mpg" > 1) AND "price" IS NOT NULL`);
    expect(mpg).toContain(`row_number() OVER (ORDER BY "mpg") AS r`);
    // Stata percentile: x_(ceil(h)) for h = N*p/100, or the average of
    // x_(h) and x_(h+1) when h is an integer
    expect(price).toContain(
      "CAST(CASE WHEN any_value(n) * 25 % 100 = 0" +
        " THEN (max(v) FILTER (WHERE r = n * 25 // 100)" +
        " + max(v) FILTER (WHERE r = n * 25 // 100 + 1)) / 2.0" +
        " ELSE max(v) FILTER (WHERE r = (n * 25 + 99) // 100) END" +
        " AS DOUBLE) AS p25"
    );
    expect(price).toContain(
      `CAST(max(v) FILTER (WHERE r = 2) AS DOUBLE) AS small_2`
    );
    expect(price).toContain(
      `CAST(max(v) FILTER (WHERE r = n - 3) AS DOUBLE) AS large_4`
    );
    // central moments about the variable's own mean
    expect(price).toContain(`CAST(avg(pow(v - mean, 3)) AS DOUBLE) AS m3`);
    expect(price).not.toContain("GROUP BY");
  });

  test("under a by prefix the ranks restart in each group", () => {
    const p = plan("bysort make: sum price, d") as SumDetailPlan;
    const [price] = p.sqls;
    expect(price).toContain(
      `row_number() OVER (PARTITION BY "make" ORDER BY "price") AS r`
    );
    expect(price).toContain(`"make" AS g_0`);
    expect(price).toContain(`CAST(g_0 AS VARCHAR) AS by_0`);
    expect(price).toContain(`GROUP BY g_0\nORDER BY g_0\nLIMIT 500`);
    expect(p.by?.variables).toEqual(["make"]);
  });

  test("non-numeric variables are excluded; all-string varlist errors", () => {
    const p = plan("sum, d") as SumDetailPlan;
    expect(p.variables).toEqual(["price", "price_per_unit", "mpg"]);
    expect(() => plan("sum make, d")).toThrow(
      "requires at least one numeric variable"
    );
  });
});
