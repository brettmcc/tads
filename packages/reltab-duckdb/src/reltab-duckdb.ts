import * as log from "loglevel";
import * as fsPromises from "fs/promises";
import {
  colIsNumeric,
  ColumnMetadata,
  ColumnMetaMap,
  ColumnStatsMap,
  ColumnType,
  DataSourceConnection,
  DataSourceId,
  DatasetInfo,
  DataSourceNode,
  DataSourcePath,
  DataSourceProvider,
  DbDataSource,
  DbDriver,
  DuckDBDialect,
  NumericSummaryStats,
  registerProvider,
  Row,
  Schema,
  SQLDialect,
  TextSummaryStats,
} from "reltab"; // eslint-disable-line
import {
  closeConnection,
  DuckDBConnection,
  DuckDBDatabase,
  execStatements,
  queryRows,
  queryRowsWithColumnInfo,
} from "./duckdbAdapter";
import { initS3 } from "./s3utils";

export * from "./csvimport";
export {
  DuckDBDatabase,
  DuckDBConnection,
  convertDuckDBValue,
  execStatements,
  queryRows,
  queryRowsWithColumnInfo,
  closeConnection,
} from "./duckdbAdapter";

const columnTypes = DuckDBDialect.columnTypes;

let viewCounter = 0;

const genViewName = (): string => `tad_tmpView_${viewCounter++}`;

const typeLookup = (tnm: string): ColumnType => {
  const ret = columnTypes[tnm] as ColumnType | undefined;
  if (ret == null) {
    throw new Error("typeLookup: unknown type name: '" + tnm + "'");
  }
  return ret;
};

/* A little ConnectionPool class because DuckDb doesn't
 * allow concurrent queries on a connection.
 */
class ConnectionPool {
  db: DuckDBDatabase;
  private pool: DuckDBConnection[];
  private active: Set<DuckDBConnection>;

  constructor(db: DuckDBDatabase) {
    this.db = db;
    this.pool = [];
    this.active = new Set();
  }

  async take(): Promise<DuckDBConnection> {
    let conn: DuckDBConnection;
    if (this.pool.length > 0) {
      conn = this.pool.pop()!;
    } else {
      conn = await this.db.connect();
      await initS3(conn);
    }
    this.active.add(conn);
    return conn;
  }

  giveBack(conn: DuckDBConnection) {
    this.active.delete(conn);
    this.pool.push(conn);
  }

  interrupt(): void {
    for (const conn of this.active) {
      conn.interrupt();
    }
  }
}

const parsePercentage = (s: string | undefined): number | null => {
  if (s != undefined && s.endsWith("%")) {
    const noPct = s.replace(/%$/, "");
    const ret = Number.parseFloat(noPct) / 100.0;
    return ret;
  }
  return null;
};

/**
 * checkCols: check that all of the specified column names are present in the row and non-null
 */
function checkCols(row: Row, colNames: string[]): boolean {
  for (const colName of colNames) {
    if (row[colName] == null) {
      return false;
    }
  }
  return true;
}

/**
 * Take the rows from a table_info() or DESCRIBE and turn it into
 * a reltab Schema
 * @param metaRows
 */
export function schemaFromTableInfo(
  metaRows: Row[],
  columNameKey: string,
  columnTypeKey: string
): Schema {
  const extendCMap = (
    columnMetaMap: ColumnMetaMap,
    row: any,
    idx: number
  ): ColumnMetaMap => {
    const displayName = row[columNameKey];
    const columnType: string = row[columnTypeKey].toLocaleUpperCase();
    const ct = DuckDBDialect.columnTypes[columnType];
    const columnMetadata: ColumnMetadata = {
      displayName,
      columnType,
    };
    columnMetaMap[displayName] = columnMetadata;
    return columnMetaMap;
  };

  const cmMap = metaRows.reduce(extendCMap, {});
  const columnIds = metaRows.map((r) => r[columNameKey]);
  const schema = new Schema(DuckDBDialect, columnIds as string[], cmMap);
  return schema;
}

/**
 * Take the rows from a table_info() or DESCRIBE and turn it into
 * a reltab Schema
 * @param metaRows
 */
export function columnStatsFromSummarize(
  metaRows: Row[],
  columNameKey: string,
  columnTypeKey: string
): ColumnStatsMap {
  const columnStatsMap: ColumnStatsMap = {};

  for (const row of metaRows) {
    const colId = row[columNameKey] as string;
    const columnType: string = (
      row[columnTypeKey] as string
    ).toLocaleUpperCase();
    const ct = DuckDBDialect.columnTypes[columnType];
    if (
      ct &&
      colIsNumeric(ct) &&
      checkCols(row, [
        "min",
        "max",
        "approx_unique",
        "count",
        "null_percentage",
      ])
    ) {
      // numeric type!
      // DuckDb summarize stats may come back as strings or numbers depending
      // on the client; normalize via String() before parsing:
      const minVal = Number.parseFloat(String(row.min));
      const maxVal = Number.parseFloat(String(row.max));
      const approxUnique = Number.parseInt(String(row.approx_unique));
      const count = Number.parseInt(String(row.count));
      const pctNull =
        typeof row.null_percentage === "number"
          ? (row.null_percentage as number) / 100.0
          : parsePercentage(row.null_percentage as string);
      const columnStats: NumericSummaryStats = {
        statsType: "numeric",
        min: minVal,
        max: maxVal,
        approxUnique,
        count,
        pctNull,
      };
      columnStatsMap[colId] = columnStats;
    }
  }
  return columnStatsMap;
}

export class DuckDBDriver implements DbDriver {
  readonly displayName: string;
  readonly sourceId: DataSourceId;
  readonly dialect: SQLDialect = DuckDBDialect;
  dbfile: string;
  db: DuckDBDatabase;
  connPool: ConnectionPool;

  constructor(dbfile: string, db: DuckDBDatabase) {
    this.dbfile = dbfile;
    this.displayName = dbfile;
    this.sourceId = { providerName: "duckdb", resourceId: dbfile };
    this.db = db;
    this.connPool = new ConnectionPool(db);
  }

  async runSqlQuery(query: string): Promise<Row[]> {
    const conn = await this.connPool.take();
    let ret: Row[];
    try {
      log.info("runSqlQuery:\n", query);
      ret = await queryRows(conn, query);
    } finally {
      this.connPool.giveBack(conn);
    }
    return ret;
  }

  interrupt(): void {
    this.connPool.interrupt();
  }

  async getMemoryUsageBytes(): Promise<number> {
    const rows = await this.runSqlQuery(
      "SELECT coalesce(sum(memory_usage_bytes), 0) AS memory_bytes FROM duckdb_memory()"
    );
    const value = rows[0]?.memory_bytes;
    return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  }

  async getDatasetInfo(_path: DataSourcePath): Promise<DatasetInfo> {
    let sourceSizeBytes: number | null = null;
    if (this.dbfile !== ":memory:") {
      try {
        sourceSizeBytes = (await fsPromises.stat(this.dbfile)).size;
      } catch {
        sourceSizeBytes = null;
      }
    }
    return {
      sourceSizeBytes,
      memorySizeBytes: await this.getMemoryUsageBytes(),
    };
  }

  /**
   * Run a query and derive the result Schema from the result metadata,
   * avoiding the extra describe round trip.
   */
  async runSqlQueryWithSchema(
    query: string
  ): Promise<{ schema: Schema; rows: Row[] }> {
    const conn = await this.connPool.take();
    try {
      log.info("runSqlQueryWithSchema:\n", query);
      const { rows, columnNames, columnTypeNames } =
        await queryRowsWithColumnInfo(conn, query);
      const cmMap: ColumnMetaMap = {};
      columnNames.forEach((colId, idx) => {
        cmMap[colId] = {
          displayName: colId,
          columnType: columnTypeNames[idx],
        };
      });
      const schema = new Schema(DuckDBDialect, columnNames, cmMap);
      return { schema, rows };
    } finally {
      this.connPool.giveBack(conn);
    }
  }

  async getDisplayName(): Promise<string> {
    return this.displayName;
  }

  async getTableSchema(tableName: string): Promise<Schema> {
    return this.getSqlQuerySchema(tableName);
  }

  async getSqlQuerySchema(sqlQuery: string): Promise<Schema> {
    let descRows: Row[];
    const describeQuery = `describe ${sqlQuery}`;
    descRows = await this.runSqlQuery(describeQuery);

    const schema = schemaFromTableInfo(descRows, "column_name", "column_type");
    return schema;
  }

  async getSqlQueryColumnStatsMap(sqlQuery: string): Promise<ColumnStatsMap> {
    try {
      const summarizeQuery = `summarize ${sqlQuery}`;
      const descRows = await this.runSqlQuery(summarizeQuery);
      const columnStatsMap = columnStatsFromSummarize(
        descRows,
        "column_name",
        "column_type"
      );
      return columnStatsMap;
    } catch (err) {
      console.warn("*** summarize query failed: ", err);
      return {};
    }
  }

  async getRootNode(): Promise<DataSourceNode> {
    const rootNode: DataSourceNode = {
      id: this.dbfile,
      kind: "Database",
      displayName: this.dbfile,
      isContainer: true,
    };
    return rootNode;
  }
  async getChildren(dsPath: DataSourcePath): Promise<DataSourceNode[]> {
    const { path } = dsPath;
    let node: DataSourceNode;
    const tiQuery = `PRAGMA show_tables;`;
    const dbRows = await this.runSqlQuery(tiQuery);
    const tableNames: string[] = dbRows.map((row: Row) => row.name as string);
    const childNodes: DataSourceNode[] = tableNames.map((tableName) => ({
      id: tableName,
      kind: "Table",
      displayName: tableName,
      isContainer: false,
    }));
    return childNodes;
  }

  async getTableName(dsPath: DataSourcePath): Promise<string> {
    const { path } = dsPath;
    if (path.length < 1) {
      throw new Error("getTableName: empty path");
    }
    return path[path.length - 1];
  }
}

const loadExtensions = async (db: DuckDBDatabase): Promise<void> => {
  const conn = await db.connect();
  try {
    await execStatements(conn, `INSTALL 'httpfs'; LOAD 'httpfs'`);
  } catch (err) {
    log.error("caught exception loading extensions: ", err);
    log.error("(ignoring unloadable extensions...)");
  } finally {
    closeConnection(conn);
  }
};

const duckdbDataSourceProvider: DataSourceProvider = {
  providerName: "duckdb",
  connect: async (resourceId: any): Promise<DataSourceConnection> => {
    const dbfile = resourceId as string;
    const db = await DuckDBDatabase.open(dbfile);
    await loadExtensions(db);
    const driver = new DuckDBDriver(dbfile, db);
    const dsConn = new DbDataSource(driver);
    return dsConn;
  },
};

registerProvider(duckdbDataSourceProvider);
