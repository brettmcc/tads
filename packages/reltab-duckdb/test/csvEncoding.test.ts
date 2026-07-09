/**
 * Regression test: CSV files that are not UTF-8 encoded (e.g. the
 * UTF-16 CSVs that Excel and Stata export) should import via the
 * encoding-fallback retry rather than failing.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as reltab from "reltab";
import { DataSourceConnection, DbDataSource } from "reltab";
import * as reltabDuckDB from "../src/reltab-duckdb";

let testCtx: DataSourceConnection;
let tmpDir: string;

beforeAll(async () => {
  testCtx = await reltab.getConnection({
    providerName: "duckdb",
    resourceId: ":memory:",
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tad-csv-enc-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const importFile = async (fileName: string, contents: Buffer): Promise<string> => {
  const csvPath = path.join(tmpDir, fileName);
  fs.writeFileSync(csvPath, contents);
  const dbds = testCtx as DbDataSource;
  const driver = dbds.db as reltabDuckDB.DuckDBDriver;
  return reltabDuckDB.nativeCSVImport(driver.db, csvPath);
};

test("imports a UTF-16 encoded CSV via the encoding fallback", async () => {
  // real-world UTF-16 CSVs (Excel, Stata) start with a byte-order mark
  const tableName = await importFile(
    "utf16.csv",
    Buffer.from("﻿name,age\nAlice,34\nBob,28\n", "utf16le")
  );
  const res = await testCtx.evalQuery(reltab.tableQuery(tableName));
  expect(res.rowData.length).toBe(2);
  expect(res.rowData.map((r: any) => r.name)).toEqual(["Alice", "Bob"]);
});

test("imports a latin-1 encoded CSV via the encoding fallback", async () => {
  const tableName = await importFile(
    "latin1.csv",
    Buffer.from("name,city\nJosé,São Paulo\n", "latin1")
  );
  const res = await testCtx.evalQuery(reltab.tableQuery(tableName));
  expect(res.rowData.length).toBe(1);
  expect(res.rowData[0].name).toBe("José");
});
