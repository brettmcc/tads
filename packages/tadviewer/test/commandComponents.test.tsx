/**
 * @jest-environment jsdom
 *
 * Component tests for the command bar and results pane, driven through
 * the real oneref state container and command actions, with a stubbed
 * DataSourceConnection supplying canned SQL results.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Immutable from "immutable";
import { mkRef, mutableGet, refContainer, StateRef } from "oneref";
import * as React from "react";
import {
  ColumnMetaMap,
  DataSourceConnection,
  DuckDBDialect,
  ReadOnlySqlResult,
  Row,
  Schema,
  tableQuery,
} from "reltab";
import { AppState } from "../src/AppState";
import { commandSchema } from "../src/commandActions";
import { resetEntryIds } from "../src/commandState";
import { CommandBar } from "../src/components/CommandBar";
import { ResultsPane } from "../src/components/ResultsPane";
import { formatCell } from "../src/components/ResultsPane";
import { ViewParams } from "../src/ViewParams";
import { ViewState } from "../src/ViewState";

function mkSchema(): Schema {
  const cols: Array<[string, string]> = [
    ["a", "INTEGER"],
    ["b", "DOUBLE"],
    ["s", "VARCHAR"],
  ];
  const cmMap: ColumnMetaMap = {};
  for (const [colId, columnType] of cols) {
    cmMap[colId] = { displayName: colId, columnType };
  }
  return new Schema(
    DuckDBDialect,
    cols.map(([c]) => c),
    cmMap
  );
}

const schema = mkSchema();

/** canned summarize result for `sum a` (single wide aggregate row) */
const sumRows: Row[] = [{ n_0: 3, mean_0: 2, sd_0: 1, min_0: 1, max_0: 3 }];

function mkFakeDbc(): DataSourceConnection {
  const fake: Partial<DataSourceConnection> = {
    runReadOnlySql: async (sql: string): Promise<ReadOnlySqlResult> => {
      if (sql.indexOf("stddev_samp") >= 0) {
        return { schema, rows: sumRows };
      }
      return { schema, rows: [] };
    },
  };
  return fake as DataSourceConnection;
}

function mkAppState(): AppState {
  const viewParams = new ViewParams({
    displayColumns: schema.columns.slice(),
  });
  const viewState = new ViewState({
    dbc: mkFakeDbc(),
    baseQuery: tableQuery("t"),
    baseSchema: schema,
    viewParams,
    initialViewParams: viewParams,
  });
  return new AppState()
    .set("initialized", true)
    .set("viewState", viewState)
    .set("showRecordCount", false) as AppState;
}

interface HarnessProps {}

const Harness: React.FunctionComponent<
  HarnessProps & { appState: AppState; stateRef: StateRef<AppState> }
> = ({ appState, stateRef }) => (
  <div>
    <ResultsPane appState={appState} stateRef={stateRef} />
    <CommandBar appState={appState} stateRef={stateRef} />
  </div>
);

function renderHarness(): StateRef<AppState> {
  const stateRef = mkRef(mkAppState());
  const [App] = refContainer<AppState, HarnessProps>(stateRef, Harness);
  render(<App />);
  return stateRef;
}

const typeCommand = (text: string) => {
  const input = screen.getByTestId("command-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  return input;
};

beforeEach(() => {
  resetEntryIds();
});

describe("CommandBar", () => {
  test("Enter executes a command, appends a result, clears input, opens pane", async () => {
    const stateRef = renderHarness();
    const input = typeCommand("sum a");
    fireEvent.keyDown(input, { key: "Enter" });

    const entryEl = await screen.findByTestId("result-entry");
    expect(entryEl.textContent).toContain("sum a");

    const st = mutableGet(stateRef);
    expect(st.commandResults.size).toBe(1);
    expect(st.commandResults.get(0)!.status).toBe("ok");
    expect(st.resultsPaneOpen).toBe(true);
    expect(input.value).toBe("");

    // semantic table with summarize headers and values
    const table = entryEl.querySelector("table.command-result-table");
    expect(table).not.toBeNull();
    const headers = Array.from(table!.querySelectorAll("th")).map(
      (th) => th.textContent
    );
    expect(headers).toEqual(["Variable", "N", "Mean", "Std. dev.", "Min", "Max"]);
    const cells = Array.from(table!.querySelectorAll("tbody td")).map(
      (td) => td.textContent
    );
    expect(cells).toEqual(["a", "3", "2", "1", "1", "3"]);

    // generated SQL is present and expandable
    const sqlDetails = await screen.findByTestId("entry-sql");
    expect(sqlDetails.querySelector("pre")!.textContent).toContain(
      "stddev_samp"
    );
  });

  test("errors are shown near the input, preserve typed text, and append", async () => {
    const stateRef = renderHarness();
    const input = typeCommand("sum nope");
    fireEvent.keyDown(input, { key: "Enter" });

    const errEl = await screen.findByTestId("command-bar-error");
    expect(errEl.textContent).toContain("unknown variable 'nope'");
    expect(input.value).toBe("sum nope");

    const st = mutableGet(stateRef);
    expect(st.commandResults.size).toBe(1);
    expect(st.commandResults.get(0)!.status).toBe("error");
    expect(st.resultsPaneOpen).toBe(true);

    const entryErr = await screen.findByTestId("entry-error");
    expect(entryErr.textContent).toContain("unknown variable 'nope'");
  });

  test("up/down arrows navigate command history", async () => {
    renderHarness();
    let input = typeCommand("sum a");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await screen.findByTestId("result-entry");

    input = typeCommand("sum b");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("result-entry").length).toBe(2)
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((screen.getByTestId("command-input") as HTMLInputElement).value).toBe(
      "sum b"
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((screen.getByTestId("command-input") as HTMLInputElement).value).toBe(
      "sum a"
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((screen.getByTestId("command-input") as HTMLInputElement).value).toBe(
      "sum b"
    );
  });

  test("browse appends an entry but does not auto-open the pane", async () => {
    const stateRef = renderHarness();
    const input = typeCommand("bro a if b > 1");
    fireEvent.keyDown(input, { key: "Enter" });

    // wait for the entry to land in state
    await new Promise((resolve) => setTimeout(resolve, 0));
    const st = mutableGet(stateRef);
    expect(st.commandResults.size).toBe(1);
    expect(st.commandResults.get(0)!.kind).toBe("browse");
    expect(st.commandResults.get(0)!.sql.length).toBeGreaterThan(0);
    expect(st.resultsPaneOpen).toBe(false);
    // grid state updated: displayColumns projected to ['a']
    expect(st.viewState.viewParams.displayColumns).toEqual(["a"]);
    expect(st.viewState.viewParams.filterExp.opArgs.length).toBe(1);
    expect(commandSchema(st).columns).toEqual(["a"]);
  });
});

describe("ResultsPane", () => {
  test("toggle button shows/hides; clear empties history", async () => {
    const stateRef = renderHarness();
    expect(screen.queryByTestId("results-pane")).toBeNull();

    fireEvent.click(screen.getByTestId("results-toggle-button"));
    expect(screen.getByTestId("results-pane")).not.toBeNull();

    // run a command, then clear
    const input = typeCommand("sum a");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("result-entry");

    fireEvent.click(screen.getByTestId("results-clear-button"));
    expect(mutableGet(stateRef).commandResults.size).toBe(0);
    expect(screen.queryByTestId("result-entry")).toBeNull();
    // pane remains open after clearing
    expect(screen.getByTestId("results-pane")).not.toBeNull();

    fireEvent.click(screen.getByTestId("results-close-button"));
    expect(screen.queryByTestId("results-pane")).toBeNull();
  });

  test("entries accumulate in order (append-only)", async () => {
    renderHarness();
    let input = typeCommand("sum a");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("result-entry");
    input = typeCommand("sum nope");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("entry-error");

    const entries = screen.getAllByTestId("result-entry");
    expect(entries.length).toBe(2);
    expect(entries[0].textContent).toContain("sum a");
    expect(entries[1].textContent).toContain("sum nope");
  });
});

describe("formatCell", () => {
  test("formats numbers and nulls", () => {
    expect(formatCell(null)).toBe("");
    expect(formatCell(3)).toBe("3");
    expect(formatCell(1234567)).toBe("1,234,567");
    expect(formatCell(4.333333333333333)).toBe("4.333333");
    expect(formatCell(1.5275252316519468)).toBe("1.527525");
    expect(formatCell("text")).toBe("text");
  });
});
