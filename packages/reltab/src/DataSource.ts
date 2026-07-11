/**
 * Hierarchical organization of data sources.
 */

import { SQLDialect } from "./dialect";
import { QueryExp } from "./QueryExp";
import { defaultEvalQueryOptions } from "./remote/Connection";
import { Schema } from "./Schema";

import { Row, LeafSchemaMap, TableRep } from "./TableRep";
import * as log from "loglevel";
import { QueryLeafDep, TableQueryRep } from "./QueryRep";
import { ColumnStatsMap } from "./ColumnStats";
import {
  assertReadOnlySql,
  normalizeReadOnlyRow,
  ReadOnlySqlResult,
} from "./readOnlySql";

export type DataSourceKind =
  | "DataSource"
  | "Database"
  | "Dataset"
  | "Table"
  | "Directory"
  | "File";

// Static registry of globally unique DataSourceProvider names:
export type DataSourceProviderName =
  | "aws-athena"
  | "bigquery"
  | "duckdb"
  | "sqlite"
  | "snowflake"
  | "localfs"
  | "motherduck";

export interface DataSourceId {
  providerName: DataSourceProviderName;
  resourceId: string; // A provider-specific string to identify the data source (':memory', path to a directory or file, etc)
}

export interface DataSourcePath {
  sourceId: DataSourceId;
  path: string[];
}

export interface DatasetInfo {
  /** source file/database size when the source has a local on-disk form */
  sourceSizeBytes: number | null;
  /** current DuckDB buffer-manager memory attributed to the connection */
  memorySizeBytes: number | null;
  /**
   * true when this dataset supports toggling between its file-backed
   * form and a full in-memory copy (see setMaterialized)
   */
  canMaterialize?: boolean;
  /** current state of the in-memory copy toggle */
  materialized?: boolean;
  /**
   * bytes of database temp-file spill currently on disk; reported for
   * materialized datasets whose data exceeded the memory budget
   */
  spillBytes?: number | null;
  /** free physical memory on the host at poll time */
  systemFreeMemBytes?: number | null;
  /** total physical memory on the host */
  systemTotalMemBytes?: number | null;
}

/**
 * Pre-flight sizing for setMaterialized: how big the in-memory copy is
 * expected to be, alongside the host's current memory headroom.
 */
export interface MaterializeEstimate {
  /** estimated in-memory size of the dataset, null when unknown */
  estimatedBytes: number | null;
  systemFreeMemBytes: number;
  systemTotalMemBytes: number;
}

export interface DataSourceNode {
  id: string; // component of DataSourcePath.path, or fully qualified name for leaf nodes
  kind: DataSourceKind;
  displayName: string;
  description?: string;
  isContainer: boolean; // true iff this node can have children
}

export interface EvalQueryOptions {
  showQueries?: boolean;
}

export interface RunSqlQueryOpts {
  /** Mark this query as cancellable via the connection's interrupt(),
   * e.g. Stata command execution. Grid queries (evalQuery/rowCount) leave
   * this unset so an interrupted command can't cancel unrelated in-flight
   * grid fetches sharing the same underlying connection pool. */
  interruptible?: boolean;
}

/**
 * A driver for a particular database, capable of
 * executing SQL queries, obtaining schema info
 * for tables and queries, and enumerating
 * data catalog information
 */
export interface DbDriver {
  readonly sourceId: DataSourceId;
  readonly dialect: SQLDialect;

  runSqlQuery(sqlQuery: string, opts?: RunSqlQueryOpts): Promise<Row[]>;
  /**
   * Optional: run a query returning both rows and the result schema in
   * a single round trip (used by runReadOnlySql when available).
   */
  runSqlQueryWithSchema?(
    sqlQuery: string,
    opts?: RunSqlQueryOpts
  ): Promise<{ schema: Schema; rows: Row[] }>;
  getTableSchema(tableName: string): Promise<Schema>;
  getSqlQuerySchema(sqlQuery: string): Promise<Schema>;

  getSqlQueryColumnStatsMap(sqlQuery: string): Promise<ColumnStatsMap>;

  getRootNode(): Promise<DataSourceNode>;
  getChildren(path: DataSourcePath): Promise<DataSourceNode[]>;

  // Get a table name that can be used in queries:
  getTableName(path: DataSourcePath): Promise<string>;

  // display name for this connection
  getDisplayName(): Promise<string>;

  /** Interrupt currently executing queries owned by this driver. */
  interrupt?(): Promise<void> | void;

  /** Return lightweight storage metrics for a dataset path. */
  getDatasetInfo?(path: DataSourcePath): Promise<DatasetInfo>;

  /**
   * Load the dataset into an in-memory table (true) or restore its
   * file-backed form (false). Only meaningful when getDatasetInfo
   * reports canMaterialize.
   */
  setMaterialized?(path: DataSourcePath, materialized: boolean): Promise<void>;

  /** Estimate the in-memory size of the dataset before materializing. */
  getMaterializeEstimate?(path: DataSourcePath): Promise<MaterializeEstimate>;

  /**
   * Release any database resources held for this data source (imported
   * tables, views). Called when the user closes the connection.
   */
  dispose?(): Promise<void>;
}

/**
 * A local or remote connection to a data source.
 */
export interface DataSourceConnection {
  readonly sourceId: DataSourceId;

  evalQuery(
    query: QueryExp,
    offset?: number,
    limit?: number,
    options?: EvalQueryOptions
  ): Promise<TableRep>;
  rowCount(query: QueryExp, options?: EvalQueryOptions): Promise<number>;

  /**
   * Execute a single read-only (SELECT / WITH ... SELECT) statement and
   * return its schema and rows. Mutation and administrative statements
   * are rejected. bigint and Date values are normalized so local and
   * remote transports return identical results.
   */
  runReadOnlySql(sql: string): Promise<ReadOnlySqlResult>;

  /** Interrupt currently executing queries on this connection. */
  interrupt(): Promise<void>;

  /** Return source-file and in-memory size metrics when available. */
  getDatasetInfo(path: DataSourcePath): Promise<DatasetInfo>;

  /**
   * Load the dataset into an in-memory table (true) or restore its
   * file-backed form (false). Only supported when getDatasetInfo
   * reports canMaterialize; throws otherwise.
   */
  setMaterialized(path: DataSourcePath, materialized: boolean): Promise<void>;

  /**
   * Estimate the in-memory size of the dataset before materializing.
   * Only supported when getDatasetInfo reports canMaterialize; throws
   * otherwise.
   */
  getMaterializeEstimate(path: DataSourcePath): Promise<MaterializeEstimate>;

  getTableSchema(tableName: string): Promise<Schema>;

  getColumnStatsMap(query: QueryExp): Promise<ColumnStatsMap>;

  getRootNode(): Promise<DataSourceNode>;
  getChildren(path: DataSourcePath): Promise<DataSourceNode[]>;

  // Get a table name that can be used in queries:
  getTableName(path: DataSourcePath): Promise<string>;

  // display name for this connection
  getDisplayName(): Promise<string>;
}

/**
 * The standard implementation of DataSourceConnection interface,
 * backed by an underlying DbDriver.
 */
export class DbDataSource implements DataSourceConnection {
  readonly sourceId: DataSourceId;

  readonly db: DbDriver;
  private tableMap: LeafSchemaMap;

  constructor(db: DbDriver) {
    this.db = db;
    this.sourceId = db.sourceId;
    this.tableMap = {};
  }

  async getSqlForQuery(
    query: QueryExp,
    offset?: number,
    limit?: number
  ): Promise<string> {
    await this.ensureLeafDeps(query);
    const schema = query.getSchema(this.db.dialect, this.tableMap);
    const sqlQuery = query.toSql(this.db.dialect, this.tableMap, offset, limit);
    return sqlQuery;
  }

  async evalQuery(
    query: QueryExp,
    offset?: number,
    limit?: number,
    options?: EvalQueryOptions
  ): Promise<TableRep> {
    const sqlQuery = await this.getSqlForQuery(query, offset, limit);
    const schema = query.getSchema(this.db.dialect, this.tableMap);
    const trueOptions = options ? options : defaultEvalQueryOptions;

    if (trueOptions.showQueries) {
      // log.info("time to generate sql: %ds %dms", t1s, t1ns / 1e6);
      log.info("evalQuery: evaluating:\n" + sqlQuery);
    }

    const rows = await this.db.runSqlQuery(sqlQuery);
    const ret = new TableRep(schema, rows);

    /*
    if (this.showQueries) {
      log.info("time to run query: %ds %dms", t3s, t3ns / 1e6);
      log.info("time to mk table rep: %ds %dms", t4s, t4ns / 1e6);
    }
    */

    return ret;
  }

  /**
   * Execute a single validated read-only SQL statement, returning the
   * result schema (via the driver's describe) and normalized rows.
   */
  async runReadOnlySql(sql: string): Promise<ReadOnlySqlResult> {
    assertReadOnlySql(sql);
    const opts: RunSqlQueryOpts = { interruptible: true };
    if (this.db.runSqlQueryWithSchema) {
      const { schema, rows: rawRows } = await this.db.runSqlQueryWithSchema(
        sql,
        opts
      );
      return { schema, rows: rawRows.map(normalizeReadOnlyRow) };
    }
    const schema = await this.db.getSqlQuerySchema(sql);
    const rawRows = await this.db.runSqlQuery(sql, opts);
    const rows = rawRows.map(normalizeReadOnlyRow);
    return { schema, rows };
  }

  async interrupt(): Promise<void> {
    await this.db.interrupt?.();
  }

  async getDatasetInfo(path: DataSourcePath): Promise<DatasetInfo> {
    if (this.db.getDatasetInfo) {
      return this.db.getDatasetInfo(path);
    }
    return { sourceSizeBytes: null, memorySizeBytes: null };
  }

  async setMaterialized(
    path: DataSourcePath,
    materialized: boolean
  ): Promise<void> {
    if (!this.db.setMaterialized) {
      throw new Error(
        "setMaterialized: not supported by this data source"
      );
    }
    await this.db.setMaterialized(path, materialized);
  }

  async getMaterializeEstimate(
    path: DataSourcePath
  ): Promise<MaterializeEstimate> {
    if (!this.db.getMaterializeEstimate) {
      throw new Error(
        "getMaterializeEstimate: not supported by this data source"
      );
    }
    return this.db.getMaterializeEstimate(path);
  }

  async rowCount(query: QueryExp, options?: EvalQueryOptions): Promise<number> {
    await this.ensureLeafDeps(query);
    const countSql = query.toCountSql(this.db.dialect, this.tableMap);

    const trueOptions = options ? options : defaultEvalQueryOptions;

    if (trueOptions.showQueries) {
      // log.info("time to generate sql: %ds %dms", t1s, t1ns / 1e6);
      log.debug("rowCount: evaluating: \n" + countSql);
    }

    const rows = await this.db.runSqlQuery(countSql);
    let rowCount = rows[0].rowCount as number;
    if (typeof rowCount === "bigint") {
      const rcVal = rowCount as bigint;
      rowCount = Number.parseInt(rcVal.toString());
    }
    return rowCount;
  }

  // ensure every table (or base query) mentioned in query is registered:
  async ensureLeafDeps(query: QueryExp): Promise<void> {
    const leafDepsMap = query.getLeafDeps();
    for (const [leafKey, leafQuery] of leafDepsMap.entries()) {
      if (this.tableMap[leafKey] === undefined) {
        await this.getLeafDepSchema(leafKey, leafQuery);
      }
    }
  }

  async getLeafDepSchema(
    leafKey: string,
    leafQuery: QueryLeafDep
  ): Promise<Schema> {
    let schema: Schema | undefined = this.tableMap[leafKey];
    if (!schema) {
      switch (leafQuery.operator) {
        case "table":
          schema = await this.db.getTableSchema(leafQuery.tableName);
          break;
        case "sql":
          schema = await this.db.getSqlQuerySchema(leafQuery.sqlQuery);
          break;
        default:
          const invalidQuery: never = leafQuery;
          throw new Error(
            "getLeafDepInfo: Unknown operator for leaf query: " + leafQuery
          );
      }
      if (schema) {
        this.tableMap[leafKey] = schema;
      }
    }
    return schema;
  }

  async getSchema(query: QueryExp): Promise<Schema> {
    await this.ensureLeafDeps(query);
    const schema = query.getSchema(this.db.dialect, this.tableMap);
    return schema;
  }

  getTableSchema(tableName: string): Promise<Schema> {
    const leafDep: TableQueryRep = { operator: "table", tableName };
    const leafKey = JSON.stringify(leafDep);
    return this.getLeafDepSchema(leafKey, leafDep);
  }

  async getColumnStatsMap(query: QueryExp): Promise<ColumnStatsMap> {
    const sqlQuery = await this.getSqlForQuery(query);
    const columnStatsMap = await this.db.getSqlQueryColumnStatsMap(sqlQuery);
    return columnStatsMap;
  }

  getRootNode(): Promise<DataSourceNode> {
    return this.db.getRootNode();
  }

  getChildren(path: DataSourcePath): Promise<DataSourceNode[]> {
    return this.db.getChildren(path);
  }

  // Get a table name that can be used in queries:
  getTableName(path: DataSourcePath): Promise<string> {
    return this.db.getTableName(path);
  }

  // display name for this connection
  getDisplayName(): Promise<string> {
    return this.db.getDisplayName();
  }
}

export interface DataSourceProvider {
  readonly providerName: DataSourceProviderName;
  connect(resourceId: string): Promise<DataSourceConnection>;
}
