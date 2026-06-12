/**
 * Import CSV files into DuckDb
 */

import * as log from "loglevel";
import * as path from "path";
import prettyHRTime from "pretty-hrtime";
import {
  closeConnection,
  DuckDBDatabase,
  execStatements,
  queryRows,
} from "./duckdbAdapter";
import { initS3 } from "./s3utils";
let uniqMap: { [cid: string]: number } = {};

/* add a numeric _N suffix to an identifer to make it unique */
const uniquify = (src: string): string => {
  let entry = uniqMap[src];
  if (entry === undefined) {
    uniqMap[src] = 1;
    return src; // no suffix needed
  }
  const ret = src + "_" + entry.toString();
  uniqMap[src] = ++entry;
  return ret;
};

/* map to alphanumeric */
const mapIdent = (src: string): string => {
  const ret = src.replace(/[^a-z0-9_]/gi, "_");
  return ret;
};

const isAlpha = (ch: string): boolean => /^[A-Z]$/i.test(ch);

const MAXLEN = 16;

/* generate a SQL table name from pathname */
const genTableName = (pathname: string): string => {
  const extName = path.extname(pathname);
  const baseName = path.basename(pathname, extName);
  let baseIdent = mapIdent(baseName);
  if (baseIdent.length >= MAXLEN) {
    baseIdent = baseIdent.slice(0, MAXLEN);
  }
  if (!isAlpha(baseIdent[0])) {
    baseIdent = "t_" + baseIdent;
  }
  const tableName = uniquify(baseIdent);
  return tableName;
};

/**
 * Native import using DuckDB's built-in import facilities.
 */
export const nativeCSVImport = async (
  db: DuckDBDatabase,
  filePath: string,
  tableName?: string
): Promise<string> => {
  const importStart = process.hrtime();

  const dbConn = await db.connect();
  try {
    await initS3(dbConn);
    if (!tableName) {
      tableName = genTableName(filePath);
    }
    const query = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_csv_auto('${filePath}')`;
    try {
      const resRows = await queryRows(dbConn, query);
      const info = resRows[0];
    } catch (err) {
      console.log("caught exception while importing: ", err);
      console.log("retrying with SAMPLE_SIZE=-1:");
      const noSampleQuery = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_csv_auto('${filePath}', sample_size=-1)`;
      try {
        const resRows = await queryRows(dbConn, noSampleQuery);
        const info = resRows[0];
        log.debug(
          'nativeCSVImport: info.Count: "' + info.Count + '", type: ',
          typeof info.Count
        );
      } catch (noSampleErr) {
        console.log("caught exception with no sampling: ", noSampleErr);
        throw noSampleErr;
      }
    }
  } finally {
    closeConnection(dbConn);
  }
  const importTime = process.hrtime(importStart);
  log.info(
    "DuckDB nativeCSVImport: import completed in ",
    prettyHRTime(importTime)
  );

  return tableName;
};

/**
 * Native import using DuckDB's built-in import facilities.
 */
export const nativeParquetImport = async (
  db: DuckDBDatabase,
  filePath: string,
  tableName?: string
): Promise<string> => {
  const importStart = process.hrtime();

  const dbConn = await db.connect();
  try {
    await initS3(dbConn);
    if (!tableName) {
      tableName = genTableName(filePath);
    }
    const query = `CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM parquet_scan('${filePath}')`;
    log.debug("*** parquet import: ", query);
    try {
      // Creating a view doesn't return a useful result.
      await execStatements(dbConn, query);
    } catch (err) {
      console.log("caught exception while importing: ", err);
      throw err;
    }
  } finally {
    closeConnection(dbConn);
  }
  const [es, ens] = process.hrtime(importStart);
  log.info(
    "DuckDB nativeParquetImport: import completed in %ds %dms",
    es,
    ens / 1e6
  );

  return tableName;
};
