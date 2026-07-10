/**
 * Top-level, transport-agnostic async entry points for reltab as a
 * remote service.
 */

import * as log from "loglevel";
import * as prettyHRTime from "pretty-hrtime";
import {
  EngineReq,
  DbConnEvalQueryRequest,
  DbConnRowCountRequest,
  DbConnGetTableSchemaRequest,
  DbConnGetColumnStatsMapRequest,
  DbConnGetChildrenRequest,
  DbConnGetTableNameRequest,
  DbConnRunReadOnlySqlRequest,
  DbConnGetDatasetInfoRequest,
  DbConnSetMaterializedRequest,
  ReltabConnection,
} from "./Connection";
import { ReadOnlySqlResult } from "../readOnlySql";
import {
  DataSourceConnection,
  DataSourceId,
  DatasetInfo,
  DataSourceNode,
  DataSourcePath,
  DataSourceProvider,
} from "../DataSource";
import { deserializeQueryReq, QueryExp } from "../QueryExp";
import {
  RequestHandler,
  TransportClient,
  TransportServer,
} from "./Transport";
import { TableRep } from "../TableRep";
import { Result } from "./result";
import { serializeError } from "./errorUtils";
import { Schema } from "../Schema";
import { ColumnStatsMap } from "../ColumnStats";

/**
 * Server handlers return plain structured-cloneable values: class
 * instances (TableRep, Schema) are converted to their JSON forms here,
 * and the client-side connection revives them. Row values (bigint, Date,
 * Buffer) pass through the transport natively.
 */
const dbConnEvalQuery = async (
  conn: DataSourceConnection,
  req: DbConnEvalQueryRequest
): Promise<any> => {
  const query = deserializeQueryReq(req.queryStr) as any;
  const hrstart = process.hrtime();
  const offset = req.offset ? req.offset : undefined;
  const limit = req.limit ? req.limit : undefined;
  const options = req.options ? req.options : undefined;
  const qres = await conn.evalQuery(query, offset, limit, options);
  const elapsed = process.hrtime(hrstart);
  log.info("runQuery: evaluated query in  ", prettyHRTime(elapsed));
  return { schema: qres.schema.toJSON(), rowData: qres.rowData };
};

const dbConnRowCount = async (
  conn: DataSourceConnection,
  req: DbConnRowCountRequest
): Promise<number> => {
  const query = deserializeQueryReq(req.queryStr) as any;
  const hrstart = process.hrtime();
  const count = await conn.rowCount(query, req.options);
  const elapsed = process.hrtime(hrstart);
  log.info("rowCount: evaluated query in", prettyHRTime(elapsed));
  return count;
};

const dbConnGetRootNode = async (
  conn: DataSourceConnection
): Promise<DataSourceNode> => {
  const hrstart = process.hrtime();
  const rootNode = await conn.getRootNode();
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetRootNode: evaluated in", prettyHRTime(elapsed));
  return rootNode;
};

const dbConnGetChildren = async (
  conn: DataSourceConnection,
  req: DbConnGetChildrenRequest
): Promise<DataSourceNode[]> => {
  const hrstart = process.hrtime();
  const { path } = req;
  const children = await conn.getChildren(path);
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetChildren: evaluated query in", prettyHRTime(elapsed));
  return children;
};

const dbConnGetTableName = async (
  conn: DataSourceConnection,
  req: DbConnGetTableNameRequest
): Promise<string> => {
  const hrstart = process.hrtime();
  const { path } = req;
  const tableName = await conn.getTableName(path);
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetTableName: evaluated query in", prettyHRTime(elapsed));
  return tableName;
};

const dbConnGetTableSchema = async (
  conn: DataSourceConnection,
  req: DbConnGetTableSchemaRequest
): Promise<any> => {
  const hrstart = process.hrtime();
  const { tableName } = req;
  const schema = await conn.getTableSchema(tableName);
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetTableSchema: evaluated query in", prettyHRTime(elapsed));
  return schema.toJSON();
};

const dbConnRunReadOnlySql = async (
  conn: DataSourceConnection,
  req: DbConnRunReadOnlySqlRequest
): Promise<any> => {
  const hrstart = process.hrtime();
  const result = await conn.runReadOnlySql(req.sql);
  const elapsed = process.hrtime(hrstart);
  log.info("dbConnRunReadOnlySql: evaluated query in", prettyHRTime(elapsed));
  return { schema: result.schema.toJSON(), rows: result.rows };
};

const dbConnInterrupt = async (
  conn: DataSourceConnection
): Promise<void> => {
  await conn.interrupt();
};

const dbConnGetDatasetInfo = async (
  conn: DataSourceConnection,
  req: DbConnGetDatasetInfoRequest
): Promise<DatasetInfo> => {
  return conn.getDatasetInfo(req.path);
};

const dbConnSetMaterialized = async (
  conn: DataSourceConnection,
  req: DbConnSetMaterializedRequest
): Promise<void> => {
  const hrstart = process.hrtime();
  await conn.setMaterialized(req.path, req.materialized);
  const elapsed = process.hrtime(hrstart);
  log.info("dbConnSetMaterialized: completed in", prettyHRTime(elapsed));
};

const dbConnGetColumnStatsMap = async (
  conn: DataSourceConnection,
  req: DbConnGetColumnStatsMapRequest
): Promise<ColumnStatsMap> => {
  const hrstart = process.hrtime();
  const { queryStr } = req;
  const query = deserializeQueryReq(queryStr) as any;
  const columnStatsMap = await conn.getColumnStatsMap(query);
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetColumnStatsMap: evaluated query in", prettyHRTime(elapsed));
  return columnStatsMap;
};

// an EngineReqHandler wraps a req in an EngineReq that carries an
// db engine identifier (DataSourceId) that is used to identify
// a particular Db instance for dispatching the Db request.

type EngineReqHandler<Req, Resp> = (req: EngineReq<Req>) => Promise<Resp>;

function mkEngineReqHandler<Req, Resp>(
  srvFn: (dbConn: DataSourceConnection, req: Req) => Promise<Resp>
): EngineReqHandler<Req, Resp> {
  const handler = async (ereq: EngineReq<Req>): Promise<Resp> => {
    const { engine, req } = ereq;
    const dbConn = await getConnection(engine);
    const res = srvFn(dbConn, req);
    return res;
  };
  return handler;
}

const handleDbConnEvalQuery = mkEngineReqHandler(dbConnEvalQuery);
const handleDbConnRowCount = mkEngineReqHandler(dbConnRowCount);
const handleDbConnGetRootNode = mkEngineReqHandler(dbConnGetRootNode);
const handleDbConnGetChildren = mkEngineReqHandler(dbConnGetChildren);
const handleDbConnGetTableName = mkEngineReqHandler(dbConnGetTableName);
const handleDbConnGetTableSchema = mkEngineReqHandler(dbConnGetTableSchema);
const handleDbConnGetColumnStatsMap = mkEngineReqHandler(
  dbConnGetColumnStatsMap
);
const handleDbConnRunReadOnlySql = mkEngineReqHandler(dbConnRunReadOnlySql);
const handleDbConnInterrupt = mkEngineReqHandler(dbConnInterrupt);
const handleDbConnGetDatasetInfo = mkEngineReqHandler(dbConnGetDatasetInfo);
const handleDbConnSetMaterialized = mkEngineReqHandler(dbConnSetMaterialized);

let providerRegistry: { [providerName: string]: DataSourceProvider } = {};

// Called during static initialization from linked provider library
export function registerProvider(provider: DataSourceProvider): void {
  providerRegistry[provider.providerName] = provider;
}

let instanceCache: { [key: string]: Promise<DataSourceConnection> } = {};

let resolvedConnections: DataSourceConnection[] = [];

let exportConnection: DataSourceConnection | null = null;

export function getExportConnection(): DataSourceConnection | null {
  return exportConnection;
}

/*
 * internal utility to record a DataSourceConnection in our connection cache
 * when the initial connection promise resolves.
 */
const saveOnResolve = async (
  pconn: Promise<DataSourceConnection>,
  hidden: boolean,
  forExport: boolean
): Promise<DataSourceConnection> => {
  const c = await pconn;
  if (!hidden) {
    resolvedConnections.push(c);
  }
  if (forExport) {
    exportConnection = c;
  }
  return c;
};

interface GetConnectionOptions {
  hidden: boolean; // hidden connections won't appear in getDataSources list
  forExport: boolean; // if true, use this connection for queries when exporting
}

const defaultGetConnectionOptions: GetConnectionOptions = {
  hidden: false,
  forExport: false,
};

/**
 * Used to both populate and read from the instance cache
 *
 */
export async function getConnection(
  sourceId: DataSourceId,
  options?: GetConnectionOptions
): Promise<DataSourceConnection> {
  const opts = options ?? defaultGetConnectionOptions;
  const key = JSON.stringify(sourceId);
  let connPromise: Promise<DataSourceConnection> | undefined;
  connPromise = instanceCache[key];
  if (!connPromise) {
    const { providerName, resourceId } = sourceId;
    let provider: DataSourceProvider | undefined =
      providerRegistry[providerName];

    if (!provider) {
      throw new Error(
        `getConnection: no registered DataSourceProvider for provider name '${providerName}'`
      );
    }
    connPromise = saveOnResolve(
      provider.connect(resourceId),
      opts.hidden,
      opts.forExport
    );
    instanceCache[key] = connPromise;
  }
  return connPromise;
}

const connectionNodeId = async (
  conn: DataSourceConnection
): Promise<DataSourceId> => {
  return conn.sourceId;
};

interface GetDataSourcesResult {
  dataSourceIds: DataSourceId[];
}

async function getDataSources(): Promise<DataSourceId[]> {
  const nodeIds: Promise<DataSourceId>[] =
    resolvedConnections.map(connectionNodeId);
  return Promise.all(nodeIds);
}

const handleGetDataSources = async (): Promise<GetDataSourcesResult> => {
  const hrstart = process.hrtime();
  const dataSourceIds = await getDataSources();
  const elapsed = process.hrtime(hrstart);
  // log.info("getDataSources: evaluated in  ", prettyHRTime(elapsed));
  const resObj = {
    dataSourceIds,
  };
  return resObj;
};

/**
 * server side of getSourceInfo standalone function, which operates on absolute paths.
 */
interface GetSourceInfoRequest {
  path: DataSourcePath;
}

interface GetSourceInfoResult {
  sourceInfo: DataSourceNode;
}

type AnyReqHandler = (req: any) => Promise<any>;

type ResultReqHandler<T> = (req: any) => Promise<Result<T>>;

const exceptionHandler =
  (hf: AnyReqHandler): ResultReqHandler<any> =>
  async (req: any) => {
    try {
      const value = await hf(req);
      return { status: "Ok", value };
    } catch (errVal) {
      console.error(
        "reltab server: exceptionHandler caught error: ",
        errVal,
        (errVal as any).stack
      );
      return { status: "Err", errVal: serializeError(errVal as Error) };
    }
  };

export const serverInit = (ts: TransportServer) => {
  ts.registerInvokeHandler(
    "getDataSources",
    exceptionHandler(handleGetDataSources)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.evalQuery",
    exceptionHandler(handleDbConnEvalQuery)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.rowCount",
    exceptionHandler(handleDbConnRowCount)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getRootNode",
    exceptionHandler(handleDbConnGetRootNode)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getChildren",
    exceptionHandler(handleDbConnGetChildren)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getTableName",
    exceptionHandler(handleDbConnGetTableName)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getTableSchema",
    exceptionHandler(handleDbConnGetTableSchema)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getColumnStatsMap",
    exceptionHandler(handleDbConnGetColumnStatsMap)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.runReadOnlySql",
    exceptionHandler(handleDbConnRunReadOnlySql)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.interrupt",
    exceptionHandler(handleDbConnInterrupt)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getDatasetInfo",
    exceptionHandler(handleDbConnGetDatasetInfo)
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.setMaterialized",
    exceptionHandler(handleDbConnSetMaterialized)
  );
};

/**
 * Useful when we want to make utility routines that can work either
 * locally or remotely
 */
export class LocalReltabConnection implements ReltabConnection {
  private static instance: LocalReltabConnection | null;
  private constructor() {}
  static getInstance(): LocalReltabConnection {
    if (!LocalReltabConnection.instance) {
      LocalReltabConnection.instance = new LocalReltabConnection();
    }
    return LocalReltabConnection.instance;
  }

  async connect(sourceId: DataSourceId): Promise<DataSourceConnection> {
    return getConnection(sourceId);
  }

  async getDataSources(): Promise<DataSourceId[]> {
    return getDataSources();
  }
}
