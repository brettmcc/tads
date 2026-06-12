/**
 * Actions for the Stata-style command bar: executing a command line
 * against the current view and managing the append-only results log
 * and results-pane visibility.
 */

import { mutableGet, StateRef, update } from "oneref";
import { FilterExp, Schema } from "reltab";
import { AppState } from "./AppState";
import {
  CommandResultEntry,
  entryAutoOpensPane,
  mkResultEntry,
} from "./commandState";
import {
  CommandExecutionContext,
  executeCommand,
} from "./stataCommand";
import { ViewParams } from "./ViewParams";
import { ViewState } from "./ViewState";

/**
 * The schema commands resolve against: the base schema of the current
 * view minus the synthetic "Rec" record-count column that aggtree
 * appends when showRecordCount is enabled.
 */
export function commandSchema(appState: AppState): Schema {
  const baseSchema = appState.viewState.baseSchema;
  if (!appState.showRecordCount) {
    return baseSchema;
  }
  const cols = baseSchema.columns;
  if (cols.length === 0 || cols[cols.length - 1] !== "Rec") {
    return baseSchema;
  }
  const dataCols = cols.slice(0, cols.length - 1);
  const metaMap: { [colId: string]: any } = {};
  for (const colId of dataCols) {
    metaMap[colId] = baseSchema.columnMetadata[colId];
  }
  return new Schema(baseSchema.dialect, dataCols, metaMap);
}

/** apply a browse command's projection + filter to the main grid */
function applyBrowseToView(
  stateRef: StateRef<AppState>,
  columns: string[],
  filterExp: FilterExp | null
): void {
  update(
    stateRef,
    (st: AppState): AppState =>
      st.updateIn(["viewState", "viewParams"], (vpu: unknown) => {
        const vp = vpu as ViewParams;
        return vp
          .set("displayColumns", columns)
          .set(
            "filterExp",
            filterExp === null ? new FilterExp() : filterExp
          ) as ViewParams;
      }) as AppState
  );
}

function appendEntry(
  stateRef: StateRef<AppState>,
  entry: CommandResultEntry
): void {
  update(stateRef, (st: AppState): AppState => {
    let nextSt = st.set(
      "commandResults",
      st.commandResults.push(entry)
    ) as AppState;
    if (entryAutoOpensPane(entry)) {
      nextSt = nextSt.set("resultsPaneOpen", true) as AppState;
    }
    return nextSt;
  });
}

/**
 * Execute a command line. Appends exactly one result entry (success or
 * error); resolves when execution completes. No-op for blank input or
 * when another command is already running.
 */
export async function runCommandLine(
  input: string,
  stateRef: StateRef<AppState>
): Promise<CommandResultEntry | null> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const appState = mutableGet(stateRef);
  if (appState.commandRunning) {
    return null;
  }
  const viewState: ViewState | null = appState.viewState;
  if (viewState == null || viewState.baseQuery == null) {
    return null;
  }

  update(stateRef, (st) => st.set("commandRunning", true) as AppState);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const ctx: CommandExecutionContext = {
      schema: commandSchema(appState),
      dialect: viewState.baseSchema.dialect,
      baseQuery: viewState.baseQuery,
      runReadOnlySql: (sql: string) => viewState.dbc.runReadOnlySql(sql),
      applyBrowse: (columns, filterExp) =>
        applyBrowseToView(stateRef, columns, filterExp),
    };
    const outcome = await executeCommand(trimmed, ctx);
    const entry = mkResultEntry(outcome, startedAt, Date.now() - t0);
    appendEntry(stateRef, entry);
    return entry;
  } finally {
    update(stateRef, (st) => st.set("commandRunning", false) as AppState);
  }
}

export function toggleResultsPane(stateRef: StateRef<AppState>): void {
  update(
    stateRef,
    (st) => st.set("resultsPaneOpen", !st.resultsPaneOpen) as AppState
  );
}

export function setResultsPaneOpen(
  open: boolean,
  stateRef: StateRef<AppState>
): void {
  update(stateRef, (st) => st.set("resultsPaneOpen", open) as AppState);
}

/** clear the results log (independent of pane visibility) */
export function clearCommandResults(stateRef: StateRef<AppState>): void {
  update(
    stateRef,
    (st) =>
      st.set(
        "commandResults",
        st.commandResults.clear()
      ) as AppState
  );
}
