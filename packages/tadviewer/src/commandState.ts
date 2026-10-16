/**
 * State for the Stata-style command bar and results pane: an append-only
 * log of command results, kept separate from saved Tad view state.
 */

import { DataSourceId, DataSourcePath } from "reltab";
import { CommandKind, CommandOutcome, ResultBlock } from "./stataCommand";

export interface CommandResultEntry {
  id: string;
  command: string;
  /** undefined when the command failed before its kind was known */
  kind?: CommandKind;
  startedAt: string; // ISO 8601
  elapsedMs: number;
  /** exact generated SQL; empty for commands rejected before planning */
  sql: string;
  status: "ok" | "error";
  output?: ResultBlock[];
  error?: string;
  /** datasetKey of the dataset the command ran against */
  datasetKey?: string;
}

/**
 * Stable identity for an open dataset, used to scope command-line
 * memory (draft input and up/down history) to the dataset it was typed
 * against.
 */
export function datasetKey(dsPath: DataSourcePath): string {
  return JSON.stringify(dsPath);
}

/**
 * Does this entry belong to the dataset with the given key? Untagged
 * entries (none are created by the app) are shown everywhere.
 */
export function entryInDataset(
  entry: CommandResultEntry,
  dsKey: string
): boolean {
  return entry.datasetKey === undefined || entry.datasetKey === dsKey;
}

/** Was this entry run against a dataset of the given data source? */
export function entryInSource(
  entry: CommandResultEntry,
  sourceId: DataSourceId
): boolean {
  if (entry.datasetKey === undefined) {
    return false;
  }
  const dsPath: DataSourcePath = JSON.parse(entry.datasetKey);
  return JSON.stringify(dsPath.sourceId) === JSON.stringify(sourceId);
}

let entrySeq = 0;

/** deterministic, monotonically increasing entry ids */
export function nextEntryId(): string {
  entrySeq += 1;
  return `cmd-${entrySeq}`;
}

/** reset the id sequence (for tests) */
export function resetEntryIds(): void {
  entrySeq = 0;
}

/**
 * Build a result entry from a command outcome plus timing information.
 */
export function mkResultEntry(
  outcome: CommandOutcome,
  startedAt: string,
  elapsedMs: number,
  dsKey?: string
): CommandResultEntry {
  if (outcome.status === "ok") {
    return {
      id: nextEntryId(),
      datasetKey: dsKey,
      command: outcome.command,
      kind: outcome.kind,
      startedAt,
      elapsedMs,
      sql: outcome.sql,
      status: "ok",
      output: outcome.blocks,
    };
  }
  return {
    id: nextEntryId(),
    command: outcome.command,
    startedAt,
    elapsedMs,
    sql: "",
    status: "error",
    error: outcome.error,
    datasetKey: dsKey,
  };
}

/**
 * Should the results pane auto-open for this entry? Errors and commands
 * that produce tabular output open it; browse only updates the grid.
 */
export function entryAutoOpensPane(entry: CommandResultEntry): boolean {
  if (entry.status === "error") {
    return true;
  }
  return entry.kind !== "browse";
}
