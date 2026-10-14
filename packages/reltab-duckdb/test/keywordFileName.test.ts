/**
 * Regression test: a file whose name is a SQL keyword (order.csv,
 * group.parquet, binary.parquet, ...) used to fail to open with a parser
 * error, because its base name became an unquoted table name.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as reltab from "reltab";
import { DataSourceConnection, DbDataSource } from "reltab";
import * as reltabDuckDB from "../src/reltab-duckdb";

let testCtx: DataSourceConnection;
let tmpDir: string;

const driverDb = () => ((testCtx as DbDataSource).db as reltabDuckDB.DuckDBDriver).db;

beforeAll(async () => {
  testCtx = await reltab.getConnection({
    providerName: "duckdb",
    resourceId: ":memory:",
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tad-keyword-name-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const expectQueryable = async (tableName: string) => {
  const rowCount = await testCtx.rowCount(reltab.tableQuery(tableName));
  expect(rowCount).toBe(2);
};

test.each(["order", "Group", "select", "table"])("opens %s.csv", async (name) => {
  const csvPath = path.join(tmpDir, `${name}.csv`);
  fs.writeFileSync(csvPath, "a,b\n1,x\n2,y\n");
  const tableName = await reltabDuckDB.nativeCSVImport(driverDb(), csvPath);
  expect(tableName.toLowerCase()).not.toBe(name.toLowerCase());
  await expectQueryable(tableName);
});

test.each(["binary", "join", "where"])("opens %s.parquet", async (name) => {
  const parquetPath = path.join(tmpDir, `${name}.parquet`);
  const conn = await driverDb().connect();
  await conn.run(
    `COPY (SELECT * FROM (VALUES (1, 'x'), (2, 'y')) t(a, b))
     TO '${parquetPath.replace(/\\/g, "/")}' (FORMAT parquet)`
  );
  conn.disconnectSync();
  const tableName = await reltabDuckDB.nativeParquetImport(driverDb(), parquetPath);
  await expectQueryable(tableName);
});

test("ordinary names are unchanged", async () => {
  const csvPath = path.join(tmpDir, "sales.csv");
  fs.writeFileSync(csvPath, "a,b\n1,x\n2,y\n");
  const tableName = await reltabDuckDB.nativeCSVImport(driverDb(), csvPath);
  expect(tableName).toBe("sales");
});
