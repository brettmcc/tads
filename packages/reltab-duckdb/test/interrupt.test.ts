import { DbDataSource } from "reltab";
import { DuckDBDatabase } from "../src/duckdbAdapter";
import { DuckDBDriver } from "../src/reltab-duckdb";

jest.setTimeout(15000);

describe("DuckDB interruption", () => {
  test("interrupts active read-only work and leaves the pool reusable", async () => {
    const db = await DuckDBDatabase.open(":memory:", { readOnly: false });
    const driver = new DuckDBDriver(":memory:", db);
    const connection = new DbDataSource(driver);

    const interrupted = expect(
      connection.runReadOnlySql(
        "SELECT sum(i) AS total FROM range(1000000000000) AS values(i)"
      )
    ).rejects.toThrow(/interrupt/i);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await connection.interrupt();
    await interrupted;

    const result = await connection.runReadOnlySql("SELECT 1 AS value");
    expect(result.rows).toEqual([{ value: 1 }]);

    const info = await connection.getDatasetInfo({
      sourceId: connection.sourceId,
      path: ["values"],
    });
    expect(info.sourceSizeBytes).toBeNull();
    expect(info.memorySizeBytes).not.toBeNull();
    expect(info.memorySizeBytes!).toBeGreaterThanOrEqual(0);
  });
});
