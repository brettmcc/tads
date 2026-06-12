/**
 * SQL generation tests: exact-string assertions for the SQL emitted by
 * the command planners, including identifier quoting, literal escaping,
 * null handling, dates, and operator precedence.
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
  exprToSqlWhere,
  planCommand,
  PlanContext,
  TabulatePlan,
  SummarizePlan,
  CodebookPlan,
  BrowsePlan,
} from "../src/stataCommand/sql";

const COLUMNS: Array<[string, string]> = [
  ["a", "INTEGER"],
  ["b", "DOUBLE"],
  ["c", "INTEGER"],
  ["s", "VARCHAR"],
  ["has space", "INTEGER"],
  ["select", "VARCHAR"],
  ['quote"name', "VARCHAR"],
  ["d", "DATE"],
  ["ts", "TIMESTAMP"],
];

function mkSchema(): Schema {
  const cmMap: ColumnMetaMap = {};
  for (const [colId, columnType] of COLUMNS) {
    cmMap[colId] = { displayName: colId, columnType };
  }
  return new Schema(
    DuckDBDialect,
    COLUMNS.map(([colId]) => colId),
    cmMap
  );
}

const schema = mkSchema();
const ctx: PlanContext = {
  schema,
  dialect: DuckDBDialect,
  baseQuery: tableQuery("stata_fixture"),
};

const plan = (input: string) =>
  planCommand(resolveCommand(parseCommand(input), schema.columns), ctx);

const filterOf = (input: string): string => {
  const cmd = resolveCommand(parseCommand(input), schema.columns) as any;
  return exprToSqlWhere(cmd.filter, DuckDBDialect);
};

/* The planners wrap the base query SQL in FROM (...); reltab renders the
 * base table query as 'select * via explicit column list'. */
const BASE_FROM = [
  "FROM (",
  '  SELECT "a", "b", "c", "s", "has space", "select", "quote""name", "d", "ts"',
  "  FROM stata_fixture",
  ")",
].join("\n");

describe("filter expression SQL", () => {
  const cases: Array<[string, string]> = [
    ["sum if a > 2", `"a" > 2`],
    ["sum if a = 2", `"a" = 2`],
    ["sum if a != 2", `"a" <> 2`],
    ["sum if a ~= 2", `"a" <> 2`],
    ["sum if b >= -1.5", `"b" >= -1.5`],
    ["sum if s == 'it''s'", `"s" = 'it''s'`],
    [`sum if s == "say ""hi"""`, `"s" = 'say "hi"'`],
    ["sum if a == null", `"a" IS NULL`],
    ["sum if a != null", `"a" IS NOT NULL`],
    ["sum if null == a", `"a" IS NULL`],
    [`sum if d >= date("2026-06-12")`, `"d" >= DATE '2026-06-12'`],
    [
      `sum if ts < date("2026-06-12T10:30:00")`,
      `"ts" < TIMESTAMP '2026-06-12 10:30:00'`,
    ],
    ["sum if a > 1 & b < 2", `"a" > 1 AND "b" < 2`],
    ["sum if a > 1 | b < 2 & c == 3", `"a" > 1 OR ("b" < 2 AND "c" = 3)`],
    [
      "sum if (a > 1 | b < 2) & c == 3",
      `("a" > 1 OR "b" < 2) AND "c" = 3`,
    ],
    ["sum if `has space` > 10", `"has space" > 10`],
    ["sum if `select` == 'x'", `"select" = 'x'`],
    [`sum if \`quote"name\` == 'q1'`, `"quote""name" = 'q1'`],
    ["sum if a > b", `"a" > "b"`],
  ];
  test.each(cases)("%s", (input, expected) => {
    expect(filterOf(input)).toBe(expected);
  });
});

describe("summarize SQL", () => {
  test("single scan: per-variable aggregate columns, one query", () => {
    const p = plan("sum a s if c > 2") as SummarizePlan;
    expect(p.sql).toBe(
      [
        'SELECT count("a") AS n_0,',
        '       CAST(avg("a") AS DOUBLE) AS mean_0,',
        '       CAST(stddev_samp("a") AS DOUBLE) AS sd_0,',
        '       CAST(min("a") AS DOUBLE) AS min_0,',
        '       CAST(max("a") AS DOUBLE) AS max_0,',
        '       count("s") AS n_1,',
        "       CAST(NULL AS DOUBLE) AS mean_1,",
        "       CAST(NULL AS DOUBLE) AS sd_1,",
        "       CAST(NULL AS DOUBLE) AS min_1,",
        "       CAST(NULL AS DOUBLE) AS max_1",
        BASE_FROM,
        'WHERE ("c" > 2)',
      ].join("\n")
    );
    // exactly one scan of the base data, regardless of variable count
    expect(p.sql.match(/FROM \(/g)!.length).toBe(1);
    expect(p.sql).not.toContain("UNION ALL");
  });

  test("quoted column names are quoted in aggregates", () => {
    const p = plan('sum `quote"name`') as SummarizePlan;
    expect(p.sql).toContain(`count("quote""name") AS n_0`);
    expect(p.variables).toEqual(['quote"name']);
  });
});

describe("tabulate SQL", () => {
  test("window functions, null exclusion, deterministic order", () => {
    const p = plan("tab s if a != null") as TabulatePlan;
    expect(p.sql).toBe(
      [
        'SELECT CAST("s" AS VARCHAR) AS value,',
        "       count(*) AS freq,",
        "       100.0 * count(*) / sum(count(*)) OVER () AS percent,",
        '       100.0 * sum(count(*)) OVER (ORDER BY "s") / sum(count(*)) OVER () AS cum_percent,',
        "       count(*) OVER () AS n_groups",
        BASE_FROM,
        'WHERE ("a" IS NOT NULL) AND "s" IS NOT NULL',
        'GROUP BY "s"',
        'ORDER BY "s"',
        "LIMIT 1000",
      ].join("\n")
    );
  });

  test("unfiltered tab still excludes nulls", () => {
    const p = plan("tab s") as TabulatePlan;
    expect(p.sql).toContain(`WHERE "s" IS NOT NULL`);
  });
});

describe("codebook SQL", () => {
  test("all stats in one scan; categorical gets top values", () => {
    const p = plan("codebook a s") as CodebookPlan;
    expect(p.variables.length).toBe(2);

    expect(p.statsSql).toBe(
      [
        'SELECT count("a") AS n_0,',
        '       count(*) - count("a") AS missing_0,',
        '       count(DISTINCT "a") AS distinct_0,',
        '       CAST(min("a") AS VARCHAR) AS min_0,',
        '       CAST(max("a") AS VARCHAR) AS max_0,',
        '       count("s") AS n_1,',
        '       count(*) - count("s") AS missing_1,',
        '       count(DISTINCT "s") AS distinct_1,',
        "       CAST(NULL AS VARCHAR) AS min_1,",
        "       CAST(NULL AS VARCHAR) AS max_1",
        BASE_FROM,
      ].join("\n")
    );
    // single scan for all per-variable stats
    expect(p.statsSql.match(/FROM \(/g)!.length).toBe(1);

    const [aPlan, sPlan] = p.variables;
    expect(aPlan.ordered).toBe(true);
    expect(aPlan.sqlType).toBe("INTEGER");
    expect(aPlan.topValuesSql).toBeUndefined();

    expect(sPlan.ordered).toBe(false);
    expect(sPlan.sqlType).toBe("VARCHAR");
    expect(sPlan.topValuesSql).toBe(
      [
        'SELECT CAST("s" AS VARCHAR) AS value,',
        "       count(*) AS freq",
        BASE_FROM,
        'WHERE "s" IS NOT NULL',
        'GROUP BY "s"',
        "ORDER BY freq DESC, value ASC",
        "LIMIT 10",
      ].join("\n")
    );
  });

  test("date variables are ordered", () => {
    const p = plan("codebook d ts") as CodebookPlan;
    expect(p.variables[0].ordered).toBe(true);
    expect(p.variables[1].ordered).toBe(true);
  });
});

describe("browse plan", () => {
  test("projects requested columns and compiles the filter", () => {
    const p = plan("bro a b if c > 2") as BrowsePlan;
    expect(p.columns).toEqual(["a", "b"]);
    expect(p.filterExp).not.toBeNull();
    expect(p.filterExp!.toSqlWhere(DuckDBDialect)).toBe(`"c">2`);
    expect(p.sql).toMatchSnapshot("browse-sql");
  });

  test("no filter yields null filterExp", () => {
    const p = plan("bro a") as BrowsePlan;
    expect(p.filterExp).toBeNull();
    expect(p.sql).toContain(`SELECT "a"`);
  });

  test("nested boolean filter compiles to nested FilterExp", () => {
    const p = plan("bro a if (a > 1 | b < 2) & c == 3") as BrowsePlan;
    expect(p.filterExp!.toSqlWhere(DuckDBDialect)).toBe(
      `("a">1 OR "b"<2) AND "c"=3`
    );
  });

  test("string filter with double quote survives FilterExp rendering", () => {
    const p = plan(`bro a if s == "say ""hi"""`) as BrowsePlan;
    expect(p.filterExp!.toSqlWhere(DuckDBDialect)).toBe(`"s"='say "hi"'`);
  });
});
