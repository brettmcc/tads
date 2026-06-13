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
  GridUpdate,
} from "./stataCommand";
import { ViewParams } from "./ViewParams";
import { ViewState } from "./ViewState";

/**
 * The schema of the command session's dataset: the current view's
 * visible columns, in display order, minus the synthetic "Rec"
 * record-count column that aggtree appends when showRecordCount is
 * enabled. keep/drop/order (and UI column changes) therefore shape what
 * subsequent commands see.
 */
export function commandSchema(appState: AppState): Schema {
  const baseSchema = appState.viewState.baseSchema;
  const displayColumns = appState.viewState.viewParams.displayColumns;
  const dataCols = displayColumns.filter(
    (colId) =>
      baseSchema.columnMetadata[colId] !== undefined &&
      !(appState.showRecordCount && colId === "Rec")
  );
  const metaMap: { [colId: string]: any } = {};
  for (const colId of dataCols) {
    metaMap[colId] = baseSchema.columnMetadata[colId];
  }
  return new Schema(baseSchema.dialect, dataCols, metaMap);
}

/** apply a grid command's view-state update */
function applyGridToView(
  stateRef: StateRef<AppState>,
  gridUpdate: GridUpdate
): void {
  update(stateRef, (st: AppState): AppState => {
    let nextSt = st.updateIn(["viewState", "viewParams"], (vpu: unknown) => {
      let vp = vpu as ViewParams;
      if (gridUpdate.displayColumns !== undefined) {
        vp = vp.set("displayColumns", gridUpdate.displayColumns) as ViewParams;
      }
      if (gridUpdate.sortKey !== undefined) {
        vp = vp.set("sortKey", gridUpdate.sortKey) as ViewParams;
      }
      if (gridUpdate.gridFilterExp !== undefined) {
        vp = vp.set(
          "filterExp",
          gridUpdate.gridFilterExp === null
            ? new FilterExp()
            : gridUpdate.gridFilterExp
        ) as ViewParams;
      }
      return vp;
    }) as AppState;
    if (gridUpdate.sessionFilter !== undefined) {
      nextSt = nextSt.set(
        "sessionFilter",
        gridUpdate.sessionFilter
      ) as AppState;
    }
    return nextSt;
  });
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
      sortKey: viewState.viewParams.sortKey,
      sessionFilter: appState.sessionFilter,
      runReadOnlySql: (sql: string) => viewState.dbc.runReadOnlySql(sql),
      applyGrid: (gridUpdate) => applyGridToView(stateRef, gridUpdate),
    };
    const outcome = await executeCommand(trimmed, ctx);
    const entry = mkResultEntry(outcome, startedAt, Date.now() - t0);
    appendEntry(stateRef, entry);
    return entry;
  } finally {
    update(stateRef, (st) => st.set("commandRunning", false) as AppState);
  }
}

/** Request cancellation of the currently running command query. */
export async function interruptCommand(
  stateRef: StateRef<AppState>
): Promise<void> {
  const appState = mutableGet(stateRef);
  if (!appState.commandRunning || appState.viewState?.dbc == null) {
    return;
  }
  await appState.viewState.dbc.interrupt();
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
