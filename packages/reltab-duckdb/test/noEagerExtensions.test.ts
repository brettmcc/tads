/**
 * Regression test: opening a connection must not install or load httpfs.
 * It used to, on every launch, which hung on networks that block
 * extensions.duckdb.org and tripped Windows Smart App Control, which
 * blocks the unsigned extension DLL. DuckDB autoloads it for remote
 * paths instead.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as reltab from "reltab";
import { DataSourceConnection } from "reltab";
import { setDuckDbStorageDirs } from "../src/duckdbAdapter";
import "../src/reltab-duckdb";

let tmpDir: string;
let testCtx: DataSourceConnection;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reltab-duckdb-ext-"));
  setDuckDbStorageDirs({
    extensionDirectory: path.join(tmpDir, "extensions"),
    tempDirectory: path.join(tmpDir, "tmp"),
  });
  testCtx = await reltab.getConnection({
    providerName: "duckdb",
    resourceId: ":memory:",
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("connecting leaves httpfs uninstalled and unloaded", async () => {
  const { rows } = await testCtx.runReadOnlySql(
    `SELECT installed, loaded FROM duckdb_extensions()
     WHERE extension_name = 'httpfs'`
  );
  expect(rows).toEqual([{ installed: false, loaded: false }]);
  expect(fs.existsSync(path.join(tmpDir, "extensions"))).toBe(false);
});
