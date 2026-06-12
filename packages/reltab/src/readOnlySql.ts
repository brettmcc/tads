/**
 * Narrowly scoped read-only SQL support for DataSourceConnection.
 *
 * The renderer never sends user-typed SQL through this API; command
 * planners generate SQL from a closed grammar. assertReadOnlySql is a
 * defense-in-depth guard enforced on the server side of the transport.
 */

import { Row } from "./TableRep";
import { Schema } from "./Schema";

export interface ReadOnlySqlResult {
  schema: Schema;
  rows: Row[];
}

/**
 * Validate that `sql` is a single read-only statement:
 * - must start with SELECT or WITH,
 * - no SQL comments,
 * - no statement separator `;` (except trailing, outside literals).
 *
 * Throws an Error describing the first violation.
 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trimStart();
  const firstWordMatch = /^[A-Za-z]+/.exec(trimmed);
  const firstWord = firstWordMatch ? firstWordMatch[0].toUpperCase() : "";
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new Error(
      "runReadOnlySql: only a single read-only SELECT (or WITH ... SELECT) statement is permitted"
    );
  }

  // scan for comments and statement separators outside of string literals
  // and quoted identifiers
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (sql[i + 1] === '"') {
          i++;
        } else {
          inDouble = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      throw new Error("runReadOnlySql: SQL comments are not permitted");
    }
    if (ch === "/" && sql[i + 1] === "*") {
      throw new Error("runReadOnlySql: SQL comments are not permitted");
    }
    if (ch === "$" && sql[i + 1] === "$") {
      throw new Error(
        "runReadOnlySql: dollar-quoted strings are not permitted"
      );
    }
    if (ch === ";") {
      if (sql.slice(i + 1).trim().length > 0) {
        throw new Error(
          "runReadOnlySql: only a single SQL statement is permitted"
        );
      }
    }
  }
  if (inSingle || inDouble) {
    throw new Error("runReadOnlySql: unterminated quote in SQL statement");
  }
}

/**
 * Normalize driver row values so results are identical across the local
 * and remote (JSON over IPC) transports:
 * - bigint -> number when within Number.MAX_SAFE_INTEGER, else decimal string
 * - Date -> ISO 8601 string
 * Other values pass through unchanged.
 */
export function normalizeReadOnlyRow(row: Row): Row {
  const out: Row = {};
  for (const k of Object.keys(row)) {
    const v: any = row[k];
    if (typeof v === "bigint") {
      out[k] =
        v <= BigInt(Number.MAX_SAFE_INTEGER) &&
        v >= -BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(v)
          : v.toString();
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}
