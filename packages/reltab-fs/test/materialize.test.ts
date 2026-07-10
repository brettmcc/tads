/**
 * Integration tests for the in-memory materialization toggle on
 * parquet files opened through the localfs provider.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DataSourcePath,
  DbDataSource,
  getConnection,
  Row,
} from "reltab";
import * as reltabDuckDB from "reltab-duckdb";
import "../src/reltab-fs";

let tmpDir: string;
let parquetPath: string;
let csvPath: string;

/** forward-slash form of a path for use inside SQL string literals */
const sqlPath = (p: string): string => p.replace(/\\/g, "/");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reltab-fs-test-"));
  parquetPath = path.join(tmpDir, "mat_test.parquet");
  csvPath = path.join(tmpDir, "mat_test.csv");
  const db = await reltabDuckDB.DuckDBDatabase.open(":memory:", {
    readOnly: false,
  });
  const conn = await db.connect();
  try {
    await reltabDuckDB.execStatements(
      conn,
      `COPY (SELECT range AS x, range * 2 AS y FROM range(100))
       TO '${sqlPath(parquetPath)}' (FORMAT PARQUET)`
    );
  } finally {
    reltabDuckDB.closeConnection(conn);
    db.close();
  }
  fs.writeFileSync(csvPath, "a,b\n1,2\n3,4\n");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function openFile(filePath: string): Promise<{
  dsConn: DbDataSource;
  dsPath: DataSourcePath;
  tableName: string;
}> {
  const dsConn = (await getConnection({
    providerName: "localfs",
    resourceId: filePath,
  })) as DbDataSource;
  const dsPath: DataSourcePath = {
    sourceId: dsConn.sourceId,
    path: ["."],
  };
  const tableName = await dsConn.getTableName(dsPath);
  return { dsConn, dsPath, tableName };
}

async function catalogType(
  dsConn: DbDataSource,
  tableName: string
): Promise<string> {
  const rows: Row[] = await dsConn.db.runSqlQuery(
    `SELECT table_type FROM information_schema.tables
     WHERE table_name = '${tableName}'`
  );
  return String(rows[0]?.table_type);
}

async function tableData(
  dsConn: DbDataSource,
  tableName: string
): Promise<Row[]> {
  return dsConn.db.runSqlQuery(
    `SELECT * FROM ${tableName} ORDER BY x LIMIT 5`
  );
}

test("parquet file materializes to a table and back to a view", async () => {
  const { dsConn, dsPath, tableName } = await openFile(parquetPath);

  let info = await dsConn.getDatasetInfo(dsPath);
  expect(info.canMaterialize).toBe(true);
  expect(info.materialized).toBe(false);
  expect(await catalogType(dsConn, tableName)).toBe("VIEW");
  const viewRows = await tableData(dsConn, tableName);

  await dsConn.setMaterialized(dsPath, true);
  info = await dsConn.getDatasetInfo(dsPath);
  expect(info.materialized).toBe(true);
  expect(await catalogType(dsConn, tableName)).toBe("BASE TABLE");
  expect(await tableData(dsConn, tableName)).toEqual(viewRows);

  // idempotent
  await dsConn.setMaterialized(dsPath, true);
  expect(await catalogType(dsConn, tableName)).toBe("BASE TABLE");

  await dsConn.setMaterialized(dsPath, false);
  info = await dsConn.getDatasetInfo(dsPath);
  expect(info.materialized).toBe(false);
  expect(await catalogType(dsConn, tableName)).toBe("VIEW");
  expect(await tableData(dsConn, tableName)).toEqual(viewRows);
});

test("csv files report canMaterialize false and reject the toggle", async () => {
  const { dsConn, dsPath } = await openFile(csvPath);
  const info = await dsConn.getDatasetInfo(dsPath);
  expect(info.canMaterialize).toBe(false);
  await expect(dsConn.setMaterialized(dsPath, true)).rejects.toThrow(
    /only local parquet files/
  );
});
