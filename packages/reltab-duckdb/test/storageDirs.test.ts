/**
 * setDuckDbStorageDirs (portable mode) must reach the DuckDB instance
 * config, so extensions and spill files stay out of the user profile.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  closeConnection,
  DuckDBDatabase,
  queryRows,
  setDuckDbStorageDirs,
} from "../src/duckdbAdapter";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reltab-duckdb-dirs-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("databases opened after setDuckDbStorageDirs use its directories", async () => {
  const extensionDirectory = path.join(tmpDir, "duckdb", "extensions");
  const tempDirectory = path.join(tmpDir, "duckdb", "tmp");
  setDuckDbStorageDirs({ extensionDirectory, tempDirectory });
  const db = await DuckDBDatabase.open(":memory:");
  const conn = await db.connect();
  try {
    const rows = await queryRows(
      conn,
      `SELECT current_setting('extension_directory') AS ext,
              current_setting('temp_directory') AS tmp`
    );
    expect(rows[0].ext).toBe(extensionDirectory);
    expect(rows[0].tmp).toBe(tempDirectory);
  } finally {
    closeConnection(conn);
    db.close();
  }
});
