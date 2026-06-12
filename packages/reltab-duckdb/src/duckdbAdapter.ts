/**
 * Thin adapter between reltab-duckdb and the "Neo" DuckDB Node client
 * (@duckdb/node-api). Keeps Neo API details (value wrapper classes,
 * instance/connection lifecycle) out of the rest of Tad.
 */

import {
  DuckDBArrayValue,
  DuckDBBlobValue,
  DuckDBConnection,
  DuckDBDateValue,
  DuckDBDecimalValue,
  DuckDBInstance,
  DuckDBListValue,
  DuckDBMapValue,
  DuckDBStructValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBValue,
} from "@duckdb/node-api";
import { Row } from "reltab";

export { DuckDBConnection } from "@duckdb/node-api";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert a DuckDB Neo value into the plain JS values reltab expects,
 * matching what the legacy duckdb-async driver returned:
 *
 * - null stays null
 * - BIGINT / HUGEINT / UBIGINT stay bigint (no precision loss)
 * - number / string / boolean pass through
 * - DATE / TIMESTAMP / TIMESTAMPTZ / TIMESTAMP_{S,MS,NS} become JS Date (UTC)
 * - DECIMAL becomes a JS number via DuckDBDecimalValue.toDouble().
 *   (DuckDBDialect maps DECIMAL to its real/double column type, so values
 *   beyond double precision were never preserved by the legacy driver either.)
 * - BLOB becomes a Buffer
 * - LIST / ARRAY / STRUCT / MAP convert recursively to arrays / plain objects
 * - anything else (INTERVAL, UUID, BIT, ...) falls back to its DuckDB string
 *   rendering
 */
export function convertDuckDBValue(val: DuckDBValue): any {
  if (val == null) {
    return null;
  }
  switch (typeof val) {
    case "number":
    case "string":
    case "boolean":
    case "bigint":
      return val;
  }
  if (val instanceof DuckDBDateValue) {
    return new Date(val.days * MS_PER_DAY);
  }
  if (
    val instanceof DuckDBTimestampValue ||
    val instanceof DuckDBTimestampTZValue
  ) {
    return new Date(Number(val.micros / 1000n));
  }
  if (val instanceof DuckDBTimestampMillisecondsValue) {
    return new Date(Number(val.millis));
  }
  if (val instanceof DuckDBTimestampSecondsValue) {
    return new Date(Number(val.seconds) * 1000);
  }
  if (val instanceof DuckDBTimestampNanosecondsValue) {
    return new Date(Number(val.nanos / 1000000n));
  }
  if (val instanceof DuckDBDecimalValue) {
    return val.toDouble();
  }
  if (val instanceof DuckDBBlobValue) {
    return Buffer.from(val.bytes);
  }
  if (val instanceof DuckDBListValue || val instanceof DuckDBArrayValue) {
    return val.items.map(convertDuckDBValue);
  }
  if (val instanceof DuckDBStructValue) {
    const obj: { [key: string]: any } = {};
    for (const [k, v] of Object.entries(val.entries)) {
      obj[k] = convertDuckDBValue(v);
    }
    return obj;
  }
  if (val instanceof DuckDBMapValue) {
    const obj: { [key: string]: any } = {};
    for (const entry of val.entries) {
      obj[String(entry.key)] = convertDuckDBValue(entry.value);
    }
    return obj;
  }
  return String(val);
}

/**
 * A DuckDB database handle: a Neo DuckDBInstance plus the path it was
 * opened on. Stands in for the legacy duckdb-async `Database` object.
 */
export class DuckDBDatabase {
  readonly dbfile: string;
  readonly instance: DuckDBInstance;

  private constructor(dbfile: string, instance: DuckDBInstance) {
    this.dbfile = dbfile;
    this.instance = instance;
  }

  /**
   * Open a DuckDB database. By default, on-disk database files are
   * opened with access_mode READ_ONLY so the app can never modify a
   * user's data file; the in-memory instance used for CSV/Parquet
   * imports remains writable. Pass { readOnly: false } to override
   * (used by tests that build fixtures).
   */
  static async open(
    dbfile: string,
    opts?: { readOnly?: boolean }
  ): Promise<DuckDBDatabase> {
    const readOnly = opts?.readOnly ?? dbfile !== ":memory:";
    const options: Record<string, string> = readOnly
      ? { access_mode: "READ_ONLY" }
      : {};
    const instance = await DuckDBInstance.create(dbfile, options);
    return new DuckDBDatabase(dbfile, instance);
  }

  connect(): Promise<DuckDBConnection> {
    return this.instance.connect();
  }

  close(): void {
    this.instance.closeSync();
  }
}

/**
 * Execute one or more SQL statements, discarding any result rows.
 */
export async function execStatements(
  conn: DuckDBConnection,
  sql: string
): Promise<void> {
  await conn.run(sql);
}

/**
 * Execute a single SQL query and return its result as an array of
 * plain-JS row objects.
 */
export async function queryRows(
  conn: DuckDBConnection,
  sql: string
): Promise<Row[]> {
  const reader = await conn.runAndReadAll(sql);
  const rowObjects = reader.getRowObjects();
  return rowObjects.map((rowObj) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(rowObj)) {
      row[k] = convertDuckDBValue(v);
    }
    return row;
  });
}

export interface RowsWithColumnInfo {
  rows: Row[];
  columnNames: string[];
  /** uppercase SQL type names, e.g. INTEGER, VARCHAR, DECIMAL(8,2) */
  columnTypeNames: string[];
}

/**
 * Execute a single SQL query and return its rows plus the result's
 * column names and SQL type names, avoiding a separate describe query.
 */
export async function queryRowsWithColumnInfo(
  conn: DuckDBConnection,
  sql: string
): Promise<RowsWithColumnInfo> {
  const reader = await conn.runAndReadAll(sql);
  const rowObjects = reader.getRowObjects();
  const rows = rowObjects.map((rowObj) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(rowObj)) {
      row[k] = convertDuckDBValue(v);
    }
    return row;
  });
  const columnNames = reader.columnNames();
  const columnTypeNames = reader
    .columnTypes()
    .map((t) => String(t).toUpperCase());
  return { rows, columnNames, columnTypeNames };
}

/**
 * Close a connection obtained from DuckDBDatabase.connect().
 */
export function closeConnection(conn: DuckDBConnection): void {
  conn.disconnectSync();
}
