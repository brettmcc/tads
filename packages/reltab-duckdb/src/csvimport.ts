/**
 * Import CSV files into DuckDb
 */

import * as fs from "fs";
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
 * Guess the encoding of a file DuckDB rejected as non-UTF-8: a UTF-16
 * byte-order mark identifies UTF-16 (what Excel and Stata export);
 * anything else is treated as latin-1, which accepts all byte values.
 */
const sniffFileEncoding = (filePath: string): string => {
  try {
    const fd = fs.openSync(filePath, "r");
    const bom = Buffer.alloc(2);
    fs.readSync(fd, bom, 0, 2, 0);
    fs.closeSync(fd);
    if ((bom[0] === 0xff && bom[1] === 0xfe) || (bom[0] === 0xfe && bom[1] === 0xff)) {
      return "utf-16";
    }
  } catch (err) {
    // remote or unreadable file: fall through to the permissive default
    console.log("sniffFileEncoding: could not read file header: ", err);
  }
  return "latin-1";
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
    const mkImportQuery = (opts: string[]): string => {
      const args = [`'${filePath}'`, ...opts].join(", ");
      return `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_csv_auto(${args})`;
    };
    try {
      await queryRows(dbConn, mkImportQuery([]));
    } catch (err) {
      console.log("caught exception while importing: ", err);
      // DuckDB reads only UTF-8 by default; non-UTF-8 files (e.g. the
      // UTF-16 CSVs Excel and Stata export) fail with a "not utf-8
      // encoded" error and need an explicit encoding. Other failures
      // are typically type-sniffing errors, where a full scan helps.
      const msg = String((err as any)?.message ?? err);
      const retryOptions = msg.includes("not utf-8 encoded")
        ? [[`encoding='${sniffFileEncoding(filePath)}'`]]
        : [["sample_size=-1"]];
      let imported = false;
      let lastErr = err;
      for (const opts of retryOptions) {
        console.log("retrying import with: ", opts.join(", "));
        try {
          await queryRows(dbConn, mkImportQuery(opts));
          imported = true;
          break;
        } catch (retryErr) {
          console.log("retry failed: ", retryErr);
          lastErr = retryErr;
        }
      }
      if (!imported) {
        throw lastErr;
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

/**
 * Replace the parquet-backed VIEW `tableName` with an in-memory TABLE of
 * the same name holding a full copy of the data, so subsequent queries
 * read DuckDB's native storage instead of re-decoding the parquet file.
 * The copy is built while the view still exists and the swap runs in one
 * transaction, so concurrent queries always see a queryable `tableName`.
 */
export const materializeParquetTable = async (
  db: DuckDBDatabase,
  tableName: string
): Promise<void> => {
  const start = process.hrtime();
  const dbConn = await db.connect();
  try {
    const tmpName = `${tableName}_tad_mat`;
    await execStatements(
      dbConn,
      `BEGIN TRANSACTION;
       CREATE OR REPLACE TABLE ${tmpName} AS SELECT * FROM ${tableName};
       DROP VIEW ${tableName};
       ALTER TABLE ${tmpName} RENAME TO ${tableName};
       COMMIT;`
    );
  } finally {
    closeConnection(dbConn);
  }
  const [es, ens] = process.hrtime(start);
  log.info(
    "DuckDB materializeParquetTable: completed in %ds %dms",
    es,
    ens / 1e6
  );
};

/**
 * Undo materializeParquetTable: drop the in-memory TABLE `tableName` and
 * restore the VIEW over parquet_scan of `filePath`, releasing the memory
 * held by the copy.
 */
export const dematerializeParquetTable = async (
  db: DuckDBDatabase,
  tableName: string,
  filePath: string
): Promise<void> => {
  const dbConn = await db.connect();
  try {
    await execStatements(
      dbConn,
      `BEGIN TRANSACTION;
       DROP TABLE ${tableName};
       CREATE VIEW ${tableName} AS SELECT * FROM parquet_scan('${filePath}');
       COMMIT;`
    );
  } finally {
    closeConnection(dbConn);
  }
};
