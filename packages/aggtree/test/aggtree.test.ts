import * as reltab from "reltab";
import * as aggtree from "../src/aggtree";
import { PathTree } from "../src/PathTree";
import * as reltabDuckDB from "reltab-duckdb";
import * as log from "loglevel";
import * as util from "./testUtils";
import { DataSourceConnection, DbDataSource, getConnection } from "reltab";

log.setLevel("info");

let testCtx: DataSourceConnection;

const pcols = ["Job Family", "Title", "Union", "Name", "Base", "TCOE"];
const q0 = reltab.tableQuery("barttest").project(pcols);

let tree0: aggtree.VPivotTree;

beforeAll(async (): Promise<DataSourceConnection> => {
  log.setLevel("info"); // use "debug" for even more verbosity
  testCtx = await getConnection({
    providerName: "duckdb",
    resourceId: ":memory:",
  });

  const duckDbDriver = (testCtx as DbDataSource)
    .db as reltabDuckDB.DuckDBDriver;
  await reltabDuckDB.nativeCSVImport(
    duckDbDriver.db,
    "../reltab-duckdb/test/support/barttest.csv"
  );

  const schema = await aggtree.getBaseSchema(testCtx, q0);
  log.debug("got schema: ", schema);

  tree0 = aggtree.vpivot(
    testCtx,
    q0,
    schema,
    ["Job Family", "Title"],
    "Name",
    true,
    []
  );

  return testCtx;
});

test("rootQuery Test", async () => {
  const rq0 = tree0.rootQuery;
  log.debug("root query exp:\n", rq0?.toJS());

  const res0 = await testCtx.evalQuery(rq0!);
  expect(util.sortedRows(res0)).toMatchSnapshot();
});

test("initial applyPath operations", async () => {
  const q1 = tree0.applyPath([]);
  const res1 = await testCtx.evalQuery(q1);

  const expCols = [
    "Job Family",
    "Title",
    "Union",
    "Name",
    "Base",
    "TCOE",
    "Rec",
    "_depth",
    "_pivot",
    "_isRoot",
    "_sortVal_0",
    "_sortVal_1",
    "_sortVal_2",
    "_path0",
    "_path1",
  ];

  expect(res1.schema.columns).toEqual(expCols);
  expect(res1.rowData.length).toBe(9);

  const actSum = util.columnSum(res1, "TCOE");

  expect(actSum).toBe(4691559);
});

test("open specific node", async () => {
  const q2 = tree0.applyPath(["Executive Management"]);
  const res2 = await testCtx.evalQuery(q2);
  expect(util.sortedRows(res2)).toMatchSnapshot();

  const q3 = tree0.applyPath(["Executive Management", "General Manager"]);
  const res3 = await testCtx.evalQuery(q3);
  expect(util.sortedRows(res3)).toMatchSnapshot();

  const openPaths = new PathTree({ '"Executive Management"': {} });
  const q4 = tree0.getTreeQuery(openPaths);
  const res4 = await testCtx.evalQuery(q4);
  // root + 9 job families + the 5 titles under Executive Management
  expect(res4.rowData.length).toBe(res2.rowData.length + 10);
});

// Based on aggTreeTest1 from original Tad test suite:
test("basic sorted aggTree test", async () => {
  const q0 = reltab.tableQuery("barttest").project(pcols);
  const schema = await aggtree.getBaseSchema(testCtx, q0);
  const tree0 = aggtree.vpivot(
    testCtx,
    q0,
    schema,
    ["Job Family", "Title"],
    "Name",
    true,
    [
      ["TCOE", false],
      ["Base", true],
      ["Title", true],
    ]
  );

  const sq1 = tree0.getSortQuery(1);
  const res = await testCtx.evalQuery(sq1);
  expect(util.sortedRows(res)).toMatchSnapshot();

  const sq2 = tree0.getSortQuery(2);
  const res2 = await testCtx.evalQuery(sq2);
  expect(util.sortedRows(res2)).toMatchSnapshot();

  const q1 = tree0.applyPath([]);
  const jq1 = q1.join(sq1, "_path0");
  const jres = await testCtx.evalQuery(jq1);
  expect(util.sortedRows(jres)).toMatchSnapshot();
});

test("async aggTree sortedTreeQuery test", async () => {
  const q0 = reltab.tableQuery("barttest").project(pcols);
  const schema = await aggtree.getBaseSchema(testCtx, q0);
  const tree0 = aggtree.vpivot(
    testCtx,
    q0,
    schema,
    ["Job Family", "Title"],
    "Name",
    true,
    [
      ["TCOE", false],
      ["Base", true],
      ["Title", true],
    ]
  );
  const rtc = testCtx;
  const openPaths = new PathTree({
    '"Executive Management"': { '"General Manager"': {} },
    '"Safety"': {},
  });
  const q4 = tree0.getTreeQuery(openPaths);

  const sq1 = tree0.getSortQuery(1);
  const res = await testCtx.evalQuery(sq1);
  expect(util.sortedRows(res)).toMatchSnapshot();

  const sq2 = tree0.getSortQuery(2);
  const res2 = await testCtx.evalQuery(sq2);
  expect(util.sortedRows(res2)).toMatchSnapshot();

  const jq4 = q4.join(sq1, ["_path0"]).join(sq2, ["_path0", "_path1"]);
  const jres4 = await rtc.evalQuery(jq4);
  expect(util.sortedRows(jres4)).toMatchSnapshot();

  // the sorted tree query is ordered, so its row order is part of the result
  const stq = tree0.getSortedTreeQuery(openPaths);
  const sres = await rtc.evalQuery(stq);
  expect(sres.rowData).toMatchSnapshot();
});

test("basic initial view test", async () => {
  const q0 = reltab.tableQuery("barttest").project(pcols);
  const schema = await aggtree.getBaseSchema(testCtx, q0);
  const tree0 = aggtree.vpivot(testCtx, q0, schema, [], null, false, []);
  const openPaths = new PathTree({});

  const stq = tree0.getSortedTreeQuery(openPaths);
  const sres = await testCtx.evalQuery(stq);
  expect(sres.rowData).toMatchSnapshot();
});
