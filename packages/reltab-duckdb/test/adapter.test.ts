/**
 * Integration tests for the DuckDB Neo adapter (duckdbAdapter.ts),
 * exercising value conversion semantics against a temporary on-disk
 * DuckDB database.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  closeConnection,
  DuckDBDatabase,
  execStatements,
  queryRows,
} from "../src/duckdbAdapter";

let tmpDir: string;
let dbFile: string;
let db: DuckDBDatabase;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reltab-duckdb-test-"));
  dbFile = path.join(tmpDir, "adapter-test.duckdb");
  db = await DuckDBDatabase.open(dbFile);
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("opens a database file on disk", () => {
  expect(db.dbfile).toBe(dbFile);
  expect(fs.existsSync(dbFile)).toBe(true);
});

test("execStatements executes DDL without consuming rows", async () => {
  const conn = await db.connect();
  try {
    await execStatements(
      conn,
      `CREATE TABLE conv_test (
         i INTEGER,
         big BIGINT,
         d DOUBLE,
         dec DECIMAL(8,2),
         s VARCHAR,
         b BOOLEAN,
         dt DATE,
         ts TIMESTAMP,
         bl BLOB
       );
       INSERT INTO conv_test VALUES
         (42, 9007199254740993, 1.5, 12.34, 'O''Brien said "hi"', true,
          DATE '2026-06-12', TIMESTAMP '2026-06-12 10:30:00', '\\xDE\\xAD'::BLOB),
         (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);`
    );
  } finally {
    closeConnection(conn);
  }
});

test("queryRows converts values to legacy-compatible JS types", async () => {
  const conn = await db.connect();
  let rows;
  try {
    rows = await queryRows(conn, "SELECT * FROM conv_test ORDER BY i NULLS LAST");
  } finally {
    closeConnection(conn);
  }
  expect(rows.length).toBe(2);
  const [r0, r1] = rows;

  // INTEGER -> number
  expect(r0.i).toBe(42);
  // BIGINT -> bigint, preserving values beyond Number.MAX_SAFE_INTEGER
  expect(typeof r0.big).toBe("bigint");
  expect(r0.big).toBe(9007199254740993n);
  // DOUBLE -> number
  expect(r0.d).toBe(1.5);
  // DECIMAL -> number (DuckDBDialect treats DECIMAL as a real column type)
  expect(r0.dec).toBe(12.34);
  // VARCHAR -> string, quotes intact
  expect(r0.s).toBe(`O'Brien said "hi"`);
  // BOOLEAN -> boolean
  expect(r0.b).toBe(true);
  // DATE -> JS Date at UTC midnight
  expect(r0.dt).toEqual(new Date("2026-06-12T00:00:00.000Z"));
  // TIMESTAMP -> JS Date
  expect(r0.ts).toEqual(new Date("2026-06-12T10:30:00.000Z"));
  // BLOB -> Buffer
  expect(Buffer.isBuffer(r0.bl)).toBe(true);
  expect(Array.from(r0.bl as unknown as Buffer)).toEqual([0xde, 0xad]);

  // null stays null for every column type
  for (const colId of ["i", "big", "d", "dec", "s", "b", "dt", "ts", "bl"]) {
    expect(r1[colId]).toBeNull();
  }
});

test("count(*) comes back as bigint", async () => {
  const conn = await db.connect();
  let rows;
  try {
    rows = await queryRows(conn, "SELECT count(*) AS rowCount FROM conv_test");
  } finally {
    closeConnection(conn);
  }
  expect(rows[0].rowCount).toBe(2n);
});

test("concurrent queries on separate connections", async () => {
  const queries = [1, 2, 3, 4].map(async (n) => {
    const conn = await db.connect();
    try {
      const rows = await queryRows(conn, `SELECT ${n} * 10 AS v`);
      return rows[0].v;
    } finally {
      closeConnection(conn);
    }
  });
  const results = await Promise.all(queries);
  expect(results).toEqual([10, 20, 30, 40]);
});
